# Field Service App

## Project
An offline-first system for dispatching and acceptance of on-site maintenance work, with 2 roles: technician (mobile app) and dispatcher (web). Overview and the 4 core scenarios: docs/01-overview.md

## Structure

* web/ React + Vite (JavaScript): dispatcher app
* mobile/ React Native + Expo: technician app
* server/ Node.js + Express + firebase-admin: API, sends FCM
* docs/ Design documents (SOURCE OF TRUTH)
* firebase/ firestore.rules, storage.rules, firestore.indexes.json, tests for rules

## Mandatory rules

* Before coding, read the relevant docs files. If the code conflicts with the docs, STOP and ask.
* Only do what is within the 4 core scenarios (docs/01). The "Out of scope" section means DO NOT do, even if it seems reasonable.
* Only edit inside the assigned folder. Do not edit docs/ unless asked.
* Status names and field names must match docs/02 and docs/03 exactly. Do not invent new names.
* Configuration constants (100 m, SLA...) come from the "Configuration" section of docs/01, not hard-coded in scattered places.
* Never read, print, or commit .env files or service account keys.
* When adding a new library: state the reason and whether it runs on Expo Go.
* web/ and mobile/ use the same major version of `firebase`; server/ uses `firebase-admin`. Do not upgrade major versions on your own.
* Expo-related packages in mobile/ are installed with `npx expo install`.
* Check the official documentation for the exact version before using library APIs (Expo and Firebase change quickly).
* The server does NOT trust the client: always re-verify distance, status, and permissions (docs/04).
* Write tests for pure logic: Haversine, offline queue, status transitions.
* After finishing one small task, stop and report what changed; do not do extra work on your own.

## Common commands

* Emulator: firebase emulators:start
* Web: cd web && npm run dev
* Mobile: cd mobile && npx expo start
* Server: cd server && npm run dev
* Test: npm test (in each folder)

## Conventions

* Data fields are camelCase. ALL enums (status, role, phase, error codes, flags...) are UPPER_SNAKE_CASE, in English (e.g. IN_PROGRESS).
* Coordinates: always an object { lat, lng } (in both Firestore and the API). Do not use GeoPoint.
* Time: Firestore Timestamp, UTC. The API uses ISO 8601 UTC strings.
* Distance: meters. Compass bearing: degrees 0-360, 0 = North.
* Commits: "feat(mobile): geofence check-in", "fix(server): ..."