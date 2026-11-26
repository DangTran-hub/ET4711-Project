# 06. Offline sync protocol (mobile)

## Principles
1. Every write action by the technician (check-in, submitting for acceptance) and every photo is written to local SQLite FIRST, and only then is sending attempted. The UI does not wait for the network. Whether online or not, the SAME code path is used (write to the queue; the worker sends immediately if online).
2. Every task has a client-generated ID (UUID) so that resending does not create duplicates (docs/04).
3. Sync sequentially per ticket.
4. The app being killed midway must not cause data loss.

## Data preloaded to the device (read cache)
| Data | When loaded | Table |
|---|---|---|
| Tickets assigned to the user | On opening the app while online; when a ticket changes (`onSnapshot` listener while online) | `cached_tickets` |
| Profile, role | On login | `cached_profile` |
| Device/server clock offset | Each time `/health` can be called | `clock_offset_ms` |

Accepted limitation: a ticket assigned while the phone is offline is not visible until the network returns.
Displayed state = ticket state stored in the cache + unsynced tasks in the queue (e.g. an `ASSIGNED` ticket
with a pending `CHECK_IN` item displays "Checked in, waiting to sync").

## Table `sync_queue`
| Column | Type | Meaning |
|---|---|---|
| `id` | TEXT (UUID) | = `clientEventId` / `clientReportId` / `photoId` |
| `type` | TEXT | `CHECK_IN`, `UPLOAD_PHOTO`, `UPLOAD_SIGNATURE`, `SUBMIT_REPORT` |
| `ticketId` | TEXT | Grouping and ordering |
| `payload` | TEXT (JSON) | Data to send; photos store only the local file path |
| `status` | TEXT | `PENDING`, `SYNCING`, `FAILED_RETRYABLE`, `FAILED_PERMANENT`, `BLOCKED`, `DONE` |
| `attemptCount` | INTEGER | |
| `lastErrorCode` | TEXT | Per docs/04, or `NETWORK` |
| `createdAt` | INTEGER | ms, device time |
| `nextRetryAt` | INTEGER | ms |
| `seq` | INTEGER AUTOINCREMENT | Creation order |

Table `local_photos`: `photoId`, `ticketId`, `reportDraftId`, file path, `sha256`, capture metadata (docs/02 Photo).
Photos are stored in the app's private directory (`FileSystem.documentDirectory`), NOT in the device's photo gallery.

## Sync order for one ticket
```
CHECK_IN → UPLOAD_PHOTO (each photo) → UPLOAD_SIGNATURE (if any) → SUBMIT_REPORT
```
- An item runs only when every item with a smaller `seq` OF THE SAME TICKET is `DONE`. So by the time photos are uploaded, the ticket is already `IN_PROGRESS` on the server (a Storage Rules condition).
- For redoing after `REJECTED`: there is no `CHECK_IN`, only new photos/signature/`SUBMIT_REPORT`.
- If an item is `FAILED_PERMANENT`, later items of that ticket become `BLOCKED` and the UI notifies the user.
- Different tickets sync independently.
- `SUBMIT_REPORT` is enqueued when "Submit for acceptance" is pressed.

## Check-in while offline
- The "Start work" button unlocks based on local GPS (≤ `GEOFENCE_RADIUS_M`, accuracy ≤ `GPS_MAX_ACCURACY_M`), with no network needed.
- Pressing it: write a `CHECK_IN` item (with coordinates, `capturedAt`, `mockLocationDetected`) and allow work to continue locally (taking photos).
- On sync, the server recalculates the distance itself. If `OUT_OF_GEOFENCE`: the item is `FAILED_PERMANENT`, later items are `BLOCKED`, and the ticket on the server stays `ASSIGNED`. The app tells the technician to check in again while online and standing at the right location. Photos taken earlier are marked `STALE`: they cannot be used for the new report (retake them), to avoid using photos taken before a valid check-in.

## When sync runs
App reopened / returns to foreground; network goes from offline → online (`@react-native-community/netinfo`); a new item is just added; `nextRetryAt` is due.
Only one worker runs at a time.

## Retry policy
- Retry on: network loss, timeout, 5xx, 429, 401 after token refresh, `PHOTO_NOT_FOUND`.
- Wait per `SYNC_RETRY_BACKOFF_S` (5s, 15s, 60s, 5 minutes, 15 minutes), plus random ±20%.
- Beyond `SYNC_MAX_ATTEMPTS`: `FAILED_PERMANENT`. For errors that must not be retried: `FAILED_PERMANENT` immediately, storing `lastErrorCode`.
- Network loss does NOT count toward `attemptCount`.
- Photo upload uses a fixed path based on `photoId`; if the file already exists, treat it as success (check existence/hash).

## When the app is killed midway
On opening the app, set every `SYNCING` item back to `PENDING`. All operations are idempotent, so resending is safe. Photos already taken are in `local_photos`.

## Time windows and clock skew
- Mobile sends `capturedAt` using device time; the server records `receivedAt`.
- Valid photo window: for attempt 1 it is [`checkinAt`, `completedAt`]; for attempt > 1 it is [`reviewedAt` of the previously rejected report, `completedAt`]. A photo outside the window: flag `PHOTO_TIME_OUTSIDE_WINDOW`.
- `completedAt` must not be after `receivedAt`; no timestamp may be in the future relative to `receivedAt`. Violation: flag `CLOCK_SKEW`.
- For data sent directly (not delayed by being offline) where |`receivedAt` − `capturedAt`| > `CLOCK_SKEW_FLAG_MIN`: flag `CLOCK_SKEW`.
- For data sent late due to being offline, the time difference cannot be used; rely on the window and the most recently measured `clock_offset_ms` from when the network was available.
- Flags only warn the dispatcher; they never reject automatically.

## Anti-fraud on mobile (layers)
1. Use only the in-app camera; do not call the image picker; `source = "IN_APP_CAMERA"`.
2. A watermark (time + GPS + compass) is drawn into the image pixels before computing SHA-256.
3. Record `mockLocationDetected` (Android).
4. Attach `deviceId`.
5. The server cross-checks: hash, distance, time window, hash duplicates across reports.
6. Anomalies are flagged and shown on the dispatcher's review screen.
Known limitation: rooted devices, emulators, and system modification can still get around it. State this clearly in the report.

## On-duty status and location (scenario 1)
- The technician toggles "Start shift" / "End shift": write `technicianLocations/{uid}.isOnDuty`.
- While on duty and the app is in the foreground: write location per `LOCATION_MIN_INTERVAL_S` or `LOCATION_MIN_DISTANCE_M`. Do not write while offline (the latest value overwrites when the network returns; nothing is queued).
- When the shift ends, `isOnDuty = false`.

## UI
- Status bar: "Synced" / "Waiting to sync (N)" / "Sync error (N), tap to view".
- Each ticket has a badge: waiting to send, sending, sent, error.
- `FAILED_PERMANENT`: a detail screen in Vietnamese based on `lastErrorCode` (e.g. "Bạn đang ở ngoài vùng cho phép"), with "Retry" or "Cancel task" if allowed.
- Do not allow logout while the queue has items that are not `DONE` (or warn that data will be lost).