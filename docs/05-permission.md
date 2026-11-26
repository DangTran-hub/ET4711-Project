# 05. Authorization

## Source of roles
- Roles live in **Firebase custom claims** (`request.auth.token.role`: `TECHNICIAN` or `DISPATCHER`), assigned by the server when the account is created. Clients cannot declare their own.
- Changing a role requires the user to sign in again / refresh the ID token.
- `users/{uid}.role` is for display only and is NOT used for authorization.
- Accounts are created with the script `server/scripts/create-user.js` (run with firebase-admin), outside the UI.
- The web only lets `DISPATCHER` in; mobile only lets `TECHNICIAN` stay. This is only a UI-level block; the real enforcement is in the Rules and the API.

## Enforcement mechanisms
- Direct Firestore/Storage access: Security Rules (`firebase/firestore.rules`, `firebase/storage.rules`).
- API calls: middleware checks the token, role, and ticket ownership.
- Deny everything by default; only open what is in the tables below.

## Firestore (direct client access)
| Collection | TECHNICIAN | DISPATCHER |
|---|---|---|
| `users` read | Own only | All |
| `users` write | No | No |
| `tickets` read | Only `assignedTo == uid` | All |
| `tickets` write | No (via API) | No (via API) |
| `tickets/{id}/events` read | Of tickets assigned to them | All |
| `tickets/{id}/events` write | No | No |
| `reports` read | Only `technicianUid == uid` | All |
| `reports` write | No (via API) | No (via API) |
| `technicianLocations` read | Own only | All |
| `technicianLocations` write | Only the document whose id = their own uid; only the fields `isOnDuty, location, accuracy, heading, updatedAt, schemaVersion` with the correct types; `updatedAt == request.time` | No |
| `deviceTokens` | No | No (via API only) |

Notes:
- Also check `users/{uid}.isActive` (or a claim `active`) so that deactivated accounts lose access.
- An `APPROVED` ticket cannot be edited by anyone: every change goes through the API, and the API rejects it.

## Storage
| Path | TECHNICIAN | DISPATCHER |
|---|---|---|
| `reports/{ticketId}/{clientReportId}/*` create | Only when that ticket has `assignedTo == uid` AND `status` is in {`IN_PROGRESS`, `REJECTED`}; `contentType` is `image/jpeg` or `image/png`; size ≤ `PHOTO_MAX_BYTES` | No |
| ...overwrite / delete | No | No |
| ...read | Only files of tickets assigned to them | All |
(Storage Rules use `firestore.get(...)` to look up the ticket.)

## API
| Endpoint | TECHNICIAN | DISPATCHER |
|---|---|---|
| `POST /tickets`, `/tickets/:id/assign` | | ✔ |
| `POST /tickets/:id/check-in` | ✔ (assigned) | |
| `POST /reports` | ✔ (assigned) | |
| `POST /reports/:id/approve`, `/reject` | | ✔ |
| `PUT /devices/token` | ✔ | ✔ |
| `GET /health` | public | public |

## Required tests (Emulator + `@firebase/rules-unit-testing`)
- Technician A cannot read technician B's tickets/reports.
- A technician cannot write `tickets`, `reports`, `deviceTokens`.
- A technician can write `technicianLocations/{ownUid}` but cannot write another person's, and cannot write unknown fields.
- A technician cannot upload photos when the ticket is not theirs or is `ASSIGNED`/`PENDING_REVIEW`/`APPROVED`.
- A dispatcher can read all tickets, reports, and `technicianLocations`.
- An unauthenticated user cannot read anything.