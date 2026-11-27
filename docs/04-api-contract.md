# 04. API contract (Node.js + Express)

## General principles
- Prefix `/api/v1`. JSON UTF-8.
- Authentication: `Authorization: Bearer <Firebase ID token>`. On authenticated endpoints, the server verifies the token with `firebase-admin`, reads `role` from custom claims, and requires the caller's `users/{uid}.isActive` to be `true` before processing the request (docs/05).
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
| 401 | `UNAUTHENTICATED` | Once after refreshing the token | |
| 403 | `FORBIDDEN_ROLE` | No | Wrong role |
| 403 | `ACCOUNT_INACTIVE` | No | The caller's user document is missing or its `isActive` field is not `true` |
| 403 | `NOT_ASSIGNED_TO_YOU` | No | Ticket is not assigned to you |
| 404 | `NOT_FOUND` | No | |
| 409 | `INVALID_STATE_TRANSITION` | No | Includes `details.currentStatus` |
| 422 | `OUT_OF_GEOFENCE` | Not automatically | Includes `distanceM` |
| 422 | `GPS_ACCURACY_TOO_LOW` | Not automatically | |
| 422 | `TECHNICIAN_NOT_ON_DUTY` | No | |
| 422 | `TECHNICIAN_INACTIVE` | No | |
| 422 | `PHOTO_NOT_FOUND` | Yes | A referenced photo or signature is missing from Storage |
| 422 | `PHOTO_HASH_MISMATCH` | No | A referenced photo or signature fails SHA-256 verification |
| 422 | `REPORT_INCOMPLETE` | No | Missing BEFORE/AFTER photos or required data |
| 429 | `RATE_LIMITED` | Yes, per `Retry-After` | |
| 5xx | `INTERNAL` | Yes | |
| (no response) | | Yes | Network loss, timeout |

The offline queue retries network loss, timeouts, 5xx, 429, and `PHOTO_NOT_FOUND`. On a 401 it refreshes the token once and resends as described in docs/06. Other errors stop the item permanently.

## Idempotency
Write endpoints called from mobile accept a client-generated ID (UUID v4): `clientEventId` or `clientReportId`.
Resending the same ID: return 200 with the first result, do NOT execute again.

## The server does not trust the client: what the server re-verifies itself
- Haversine distance between the submitted `location` and `ticket.location` (never a number the client computed itself); `accuracy` is good enough
- Valid state transition (docs/03); the caller is exactly the assigned person
- Photo and signature paths must match the ticket and report IDs in the request and the filename rules in docs/02. The server verifies the actual Storage file's MIME type, size, and SHA-256. An invalid path, MIME type, or size returns `400 INVALID_BODY`. A missing file or hash mismatch returns the corresponding `422` error. These errors leave the ticket and report data unchanged.
- Require `source = "IN_APP_CAMERA"` and a valid count of BEFORE and AFTER photos. A hash that matches a photo in another report raises `DUPLICATE_HASH` on an otherwise valid submission.
- Write `receivedAt` using server time. Apply the time checks in docs/06. Anomaly flags in docs/02 are for review.
- On assign: the assignee has the `TECHNICIAN` custom claim, an active user document, and `isOnDuty == true`.

Check-in and report requests include a boolean `wasDelayedOffline` set by the mobile queue (docs/06). The server uses it only for clock-skew flagging.

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
  "mockLocationDetected": false,
  "wasDelayedOffline": false
}
```
→ 200 `{ "ticketId", "status": "IN_PROGRESS", "checkinAt", "distanceM": 42 }`
Errors: 401, 403 `NOT_ASSIGNED_TO_YOU`, 409, 422 `OUT_OF_GEOFENCE` / `GPS_ACCURACY_TOO_LOW`.
Resending the same `clientEventId`: 200 with the old result.

### POST /api/v1/reports  (assigned TECHNICIAN)
Precondition: the ticket is `IN_PROGRESS` or `REJECTED`. The photos and any included signature have been uploaded to Storage.
```json
{
  "clientReportId": "uuid-v4",
  "ticketId": "abc123",
  "note": "Thay module nguồn 48V, siết lại đầu cos",
  "completedAt": "2026-11-24T09:05:00.000Z",
  "wasDelayedOffline": true,
  "photos": [
    {
      "photoId": "uuid-v4", "phase": "BEFORE",
      "storagePath": "reports/abc123/<clientReportId>/before_<photoId>.jpg",
      "sha256": "…", "capturedAt": "2026-11-24T08:21:00.000Z",
      "location": { "lat": 21.0285, "lng": 105.8020 }, "accuracy": 7, "heading": 182.5,
      "mockLocationDetected": false, "deviceId": "uuid-v4",
      "source": "IN_APP_CAMERA", "sizeBytes": 2345678
    },
    {
      "photoId": "another-uuid-v4", "phase": "AFTER",
      "storagePath": "reports/abc123/<clientReportId>/after_<anotherPhotoId>.jpg",
      "sha256": "…", "capturedAt": "2026-11-24T09:00:00.000Z",
      "location": { "lat": 21.0285, "lng": 105.8020 }, "accuracy": 8, "heading": 182.5,
      "mockLocationDetected": false, "deviceId": "uuid-v4",
      "source": "IN_APP_CAMERA", "sizeBytes": 2245678
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
