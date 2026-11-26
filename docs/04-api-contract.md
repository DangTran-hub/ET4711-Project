# 04. API contract (Node.js + Express)

## General principles
- Prefix `/api/v1`. JSON UTF-8.
- Authentication: `Authorization: Bearer <Firebase ID token>`. The server verifies it with `firebase-admin` and reads `role` from custom claims.
- Time in JSON: ISO 8601 UTC. Coordinates: `{ "lat": number, "lng": number }`.
- Only operations that need to be trusted go through the API. Reading the ticket list and reading on-duty technicians: clients read directly from Firestore under the Security Rules (docs/05).

## Unified error format
```json
{ "error": { "code": "OUT_OF_GEOFENCE", "message": "Bạn cách địa điểm 230m", "details": { "distanceM": 230 } } }
```
Clients handle errors by `code`, not by `message`.

| HTTP | `code` | Retry? | Meaning |
|---|---|---|---|
| 400 | `INVALID_BODY` | No | Wrong format / missing fields |
| 401 | `UNAUTHENTICATED` | After refreshing the token | |
| 403 | `FORBIDDEN_ROLE` | No | Wrong role |
| 403 | `NOT_ASSIGNED_TO_YOU` | No | Ticket is not assigned to you |
| 404 | `NOT_FOUND` | No | |
| 409 | `INVALID_STATE_TRANSITION` | No | Includes `details.currentStatus` |
| 422 | `OUT_OF_GEOFENCE` | Not automatically | Includes `distanceM` |
| 422 | `GPS_ACCURACY_TOO_LOW` | Not automatically | |
| 422 | `TECHNICIAN_NOT_ON_DUTY` | No | |
| 422 | `TECHNICIAN_INACTIVE` | No | |
| 422 | `PHOTO_NOT_FOUND` | Yes | File not yet in Storage (upload not finished) |
| 422 | `PHOTO_HASH_MISMATCH` | No | |
| 422 | `REPORT_INCOMPLETE` | No | Missing BEFORE/AFTER photos or required data |
| 429 | `RATE_LIMITED` | Yes, per `Retry-After` | |
| 5xx | `INTERNAL` | Yes | |
| (no response) | | Yes | Network loss, timeout |

The offline queue retries only on: network loss, 5xx, 429, 401 (after refresh), `PHOTO_NOT_FOUND`. For any other error: stop permanently.

## Idempotency
Write endpoints called from mobile accept a client-generated ID (UUID v4): `clientEventId` or `clientReportId`.
Resending the same ID: return 200 with the first result, do NOT execute again.

## The server does not trust the client: what the server re-verifies itself
- Haversine distance between the submitted `location` and `ticket.location` (never a number the client computed itself); `accuracy` is good enough
- Valid state transition (docs/03); the caller is exactly the assigned person
- Photo/signature files actually exist in Storage, with the correct `contentType`, size, and matching SHA-256
- `source = "IN_APP_CAMERA"`; `sha256` does not duplicate a photo from another report
- Number of BEFORE/AFTER photos is within limits; flags set per docs/02; `receivedAt` is written by the server
- On assign: the assignee is a `TECHNICIAN`, `isActive`, `isOnDuty`

## Endpoints

### POST /api/v1/tickets  (DISPATCHER)
```json
{
  "deviceName": "Tủ nguồn rectifier #2",
  "description": "Đèn cảnh báo đỏ, mất sóng toàn trạm",
  "siteName": "Trạm BTS Cầu Giấy 03",
  "location": { "lat": 21.0285, "lng": 105.8019 },
  "slaMinutes": 120
}
```
→ 201 `{ "ticketId", "status": "OPEN", "slaDeadline" }`. Errors: 400 (e.g. `slaMinutes` outside [`SLA_MIN_MINUTES`, `SLA_MAX_MINUTES`]).

### POST /api/v1/tickets/:ticketId/assign  (DISPATCHER)
Body: `{ "technicianUid": "..." }`
→ 200 `{ "ticketId", "status": "ASSIGNED", "assignedTo", "notificationSent": true }`
Errors: 404, 409 (not `OPEN`), 422 `TECHNICIAN_NOT_ON_DUTY` / `TECHNICIAN_INACTIVE`.
Effect: sends FCM to the technician's token (see "Notifications").

### POST /api/v1/tickets/:ticketId/check-in  (assigned TECHNICIAN)
```json
{
  "clientEventId": "uuid-v4",
  "location": { "lat": 21.0285, "lng": 105.8020 },
  "accuracy": 8,
  "capturedAt": "2026-11-24T08:15:00.000Z",
  "mockLocationDetected": false
}
```
→ 200 `{ "ticketId", "status": "IN_PROGRESS", "checkinAt", "distanceM": 42 }`
Errors: 401, 403 `NOT_ASSIGNED_TO_YOU`, 409, 422 `OUT_OF_GEOFENCE` / `GPS_ACCURACY_TOO_LOW`.
Resending the same `clientEventId`: 200 with the old result.

### POST /api/v1/reports  (assigned TECHNICIAN)
Precondition: the ticket is `IN_PROGRESS` or `REJECTED`; photos and signature have been uploaded to Storage.
```json
{
  "clientReportId": "uuid-v4",
  "ticketId": "abc123",
  "note": "Thay module nguồn 48V, siết lại đầu cos",
  "completedAt": "2026-11-24T09:05:00.000Z",
  "photos": [
    {
      "photoId": "uuid-v4", "phase": "BEFORE",
      "storagePath": "reports/abc123/<clientReportId>/before_<photoId>.jpg",
      "sha256": "…", "capturedAt": "2026-11-24T08:21:00.000Z",
      "location": { "lat": 21.0285, "lng": 105.8020 }, "accuracy": 7, "heading": 182.5,
      "mockLocationDetected": false, "deviceId": "uuid-v4",
      "source": "IN_APP_CAMERA", "sizeBytes": 2345678
    }
  ],
  "onsiteSignerName": "Trần Thị B",
  "onsiteSignature": { "storagePath": "reports/abc123/<clientReportId>/signature.png", "sha256": "…", "signedAt": "2026-11-24T09:04:00.000Z" }
}
```
`note`, `onsiteSignerName`, `onsiteSignature` may be empty/null.
→ 201 (first time) or 200 (resend): `{ "reportId", "attempt", "ticketStatus": "PENDING_REVIEW", "flags": [ { "code", "severity" } ] }`
Errors: 400, 403, 409, 422 `REPORT_INCOMPLETE` / `PHOTO_NOT_FOUND` / `PHOTO_HASH_MISMATCH`.

### POST /api/v1/reports/:reportId/approve  (DISPATCHER)
Body `{}` → 200 `{ "reportStatus": "APPROVED", "ticketStatus": "APPROVED" }`. Errors: 409.

### POST /api/v1/reports/:reportId/reject  (DISPATCHER)
Body `{ "reason": "Ảnh AFTER bị mờ" }` (required, non-empty)
→ 200 `{ "reportStatus": "REJECTED", "ticketStatus": "REJECTED", "notificationSent": true }`. Errors: 400, 409.

### PUT /api/v1/devices/token  (any logged-in role)
Body `{ "fcmToken": "..." }` → 204. Adds the token to `deviceTokens/{uid}` (no duplicates).

### GET /api/v1/health  (no auth required)
→ 200 `{ "ok": true, "time": "<ISO server time>" }`. Mobile uses it to estimate device clock skew.

## FCM notifications
| Event | Recipient | Attached `data` |
|---|---|---|
| Ticket assigned | The assigned technician | `{ "type": "TICKET_ASSIGNED", "ticketId": "..." }` |
| Report rejected | The report's technician | `{ "type": "TICKET_REJECTED", "ticketId": "..." }` |
The displayed content (title/body) is in Vietnamese and short (device name, rejection reason). Tapping the notification opens the ticket details.

## Accounts
There is no account-creation API. Accounts and the `role` custom claim are created with the script `server/scripts/create-user.js` (run by the developer).

## Extension E1
The background job "SLA overdue alert": see docs/03. It is not an endpoint.