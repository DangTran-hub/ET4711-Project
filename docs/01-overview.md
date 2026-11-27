# 01. Overview

## Description
A dispatcher creates an incident (ticket) on the web and assigns it to an on-duty technician. The technician uses a mobile app,
which also works offline (no signal), to check in on site (with a geofence check), take before/after photos with the in-app camera,
record notes on materials, collect an on-site signature, and submit the work for acceptance. The dispatcher compares the before/after photos and then approves
or requests rework. Goals: (1) work without a network connection, (2) reduce fake reports from old photos / spoofed locations.

## Roles (only 2)
| Role | `role` | Application | Can do |
|---|---|---|---|
| Technician | `TECHNICIAN` | Mobile | View assigned jobs, check in, take photos, write reports, toggle on-duty status, send location |
| Dispatcher | `DISPATCHER` | Web | Create tickets, view on-duty technicians, assign jobs, approve/reject acceptance |

## 4 core scenarios

### Scenario 1: Create an incident and dispatch (Web, dispatcher)
1. The dispatcher creates a ticket: device name (`deviceName`), fault description (`description`), picks the station/store location
   on the map (stored as `{lat, lng}`), and sets the handling deadline (`slaMinutes`, default 120). Status: `OPEN`.
2. The dispatcher views the list of on-duty technicians and assigns the ticket to one person. Status becomes `ASSIGNED`;
   the system sends a push notification (FCM) to that technician's device.

Completion criteria: the new ticket appears immediately in the web list; only on-duty technicians can be selected;
after assignment, the ticket shows in the "My jobs" list on mobile and the device receives the notification.

### Scenario 2: Travel and geofence check-in (Mobile, technician)
1. The technician opens the app and sees the list of assigned jobs. Opening a ticket's details: the app continuously reads GPS and displays
   the distance to the incident location.
2. When the distance is ≤ `GEOFENCE_RADIUS_M` (and GPS accuracy is good enough), the "Start work" button unlocks.
   Pressing it: the app sends the coordinates to Node.js for final verification. Status becomes `IN_PROGRESS`, and `checkinAt` is recorded.

Completion criteria: when farther than 100 m the button is locked; the server rejects the request if its own recalculation shows the position is outside the zone.

### Scenario 3: On-site handling and offline sync (Mobile, technician)
1. Online: take `BEFORE` and `AFTER` photos with the in-app camera (no picking from the gallery), enter notes on replaced materials,
   optionally collect a touch signature from the authorized on-site person, and tap "Submit for acceptance". Photos go to Firebase Storage,
   data goes to Node.js. Status becomes `PENDING_REVIEW`.
2. Offline: the app saves the photos (local file paths) and the form to the local queue and shows a "Waiting to sync" badge.
   When the signal returns, the app pushes them to the server sequentially, with no need to redo anything.

Completion criteria: turn on airplane mode → submit for acceptance → turn off airplane mode → the data uploads fully on its own, with no duplicates,
and the ticket becomes `PENDING_REVIEW`.

### Scenario 4: Approve acceptance or request rework (Web, dispatcher)
1. The dispatcher opens a `PENDING_REVIEW` ticket and views the Before/After photos side by side, along with capture time, GPS coordinates, and anomaly flags.
2. Pass: click Approve. Status becomes `APPROVED` (editing locked, completed).
3. Fail (blurry photo, wrong location, fault not fixed): click Reject and enter a reason. Status becomes `REJECTED`, and FCM is sent to
   the technician to retake/fix. When the technician resubmits, the ticket returns to `PENDING_REVIEW`.

## Out of scope (NOT doing)
- A manager role or any third role
- Cancelling tickets, reassigning tickets to someone else, ticket priority levels
- Structured technical measurements (text notes only)
- Account management UI (accounts are created by script, see docs/05)
- Payments, inventory, multi-language, multi-company, chat, route optimization
- iOS app (only Android is officially supported)
- Absolute fraud prevention. Only risk reduction and flagging
- The "SLA escalation" extension in docs/03 is done only AFTER the 4 scenarios run stably

## Glossary (use exactly one term for each concept)
- **Ticket**: an incident that needs to be handled at a specific location.
- **Report (acceptance report)**: the result of handling a ticket: photos, notes, signature.
- **Check-in**: a technician confirms presence at the location (geofence check); the ticket moves to `IN_PROGRESS`.
- **Geofence**: a radius-based zone around the incident location.
- **SLA**: the handling deadline set by the dispatcher (`slaDeadline`).
- **On duty**: a technician who has tapped "Start shift" in the app (`isOnDuty = true`).
- **Authorized on-site person**: a person from the station/store who signs to confirm. NOT a role in the system.
- **Offline queue (sync queue)**: a list of tasks stored on the device awaiting upload to the server.
- **Flag**: an anomaly marker attached to a report to draw the dispatcher's attention.

## Configuration (single source of truth)
| Name | Value | Meaning |
|---|---|---|
| `GEOFENCE_RADIUS_M` | 100 | Allowed radius for check-in |
| `GPS_MAX_ACCURACY_M` | 50 | If GPS accuracy is worse than this, lock the button / reject check-in |
| `GEOFENCE_WATCH_INTERVAL_MS` | 3000 | GPS update interval on the ticket details screen |
| `SLA_DEFAULT_MINUTES` | 120 | Suggested value on the ticket creation form |
| `SLA_MIN_MINUTES` / `SLA_MAX_MINUTES` | 15 / 1440 | Bounds for `slaMinutes` |
| `SLA_ESCALATION_GRACE_MIN` | 15 | (Extension) how long past `slaDeadline` before alerting |
| `LOCATION_MIN_INTERVAL_S` | 20 | While on duty, record location at most every 20 seconds |
| `LOCATION_MIN_DISTANCE_M` | 50 | ...or when moved more than 50 m |
| `LOCATION_STALE_AFTER_S` | 120 | If no update beyond this, the web shows "signal lost" |
| `CLOCK_SKEW_FLAG_MIN` | 10 | Device/server clock difference threshold for flagging |
| `PHOTO_MAX_BYTES` | 8388608 | 8 MB per photo |
| `PHOTO_MIN_PER_PHASE` / `PHOTO_MAX_PER_PHASE` | 1 / 5 | Number of photos per type (BEFORE and AFTER) |
| `SYNC_RETRY_BACKOFF_S` | 5, 15, 60, 300, 900 | Base delay after successive failed sends. Repeat the final delay if more retries remain (docs/06). |
| `SYNC_MAX_ATTEMPTS` | 8 | Maximum counted attempts per queue item, including the initial send. Stop after the last failed attempt. |

## Design decisions (finalized, do not re-propose)
1. Do not use Firestore offline persistence on mobile; build our own queue with `expo-sqlite`.
2. Sensitive data is written only through the Node.js API (create/assign ticket, check-in, submit/approve report). Clients do not write directly to `tickets` or `reports`.
3. Roles are stored in Firebase custom claims, assigned by the server.
4. A ticket can have multiple reports (rejected, then redone); each attempt is a new report with `attempt` incrementing.
5. Check-in can be performed offline: the app checks the geofence locally, adds it to the queue, and the server re-verifies when syncing (docs/06).
6. Layered anti-fraud + flagging, with no absolute guarantees. Rooted devices or modified systems remain a known weakness.
7. Maps use OpenStreetMap + Leaflet.
8. Coordinates are WGS84 in `{lat, lng}` form. Distance: Haversine.
9. FCM notifications are sent only to technicians (when assigned, when rejected). Notifications are not guaranteed to arrive, so the app always re-reads the list from Firestore on open.
