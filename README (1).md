# Punjab National College — Peshawar Chapter
## Online Examination Result Portal

This is a full-stack starter implementation: Express backend, PostgreSQL relational database, public roll-number result lookup, protected administrator login, marks entry, draft/publish/withdraw workflow, server-side totals, audit log, responsive marksheet and print-to-PDF.

**Important production limitation:** This source package is not itself a live website. You must deploy it to a public HTTPS host, configure a production PostgreSQL database and a domain/subdomain, create the first administrator securely, and run end-to-end tests. Do not announce a live public results URL until deployment and tests have succeeded.

## Stack
- Node.js 22 + Express
- PostgreSQL 16
- Server-side sessions stored in PostgreSQL
- bcrypt password hashing, Helmet security headers, rate limiting, parameterized SQL
- HTML/CSS/vanilla JavaScript frontend

## Local development (Docker recommended)
1. Install Docker Desktop or Docker Engine.
2. Copy `.env.example` to `.env`.
3. In `.env`, set a strong `SESSION_SECRET` (at least 32 random characters). Set `SESSION_COOKIE_SECURE=false` for local HTTP.
4. Add a `POSTGRES_PASSWORD` entry to `.env`, for example a long random password. This is for local development only.
5. Run `docker compose up --build -d`.
6. Apply schema: `docker compose exec app npm run db:migrate`.
7. Create an administrator:
   `docker compose exec app npm run admin:create -- collegeadmin 'Use-A-Long-Unique-Password-Here' admin@example.invalid`
   Replace the example credentials. Never use that sample password in production.
8. Open `http://localhost:3000`.

If running Node directly rather than Docker, create a PostgreSQL database and role, set `DATABASE_URL` in `.env`, run `npm install`, `npm run db:migrate`, create an admin with `npm run admin:create -- username 'a-long-password-12-chars-minimum'`, then `npm start`.

## Initial setup data
The schema seeds the subject catalogue and roles/permissions. Before using the portal:
1. Insert academic year(s) in `academic_years`.
2. Insert classes in `classes`.
3. Optionally insert sections in `sections` linked to classes.
4. Add students from the administrator panel.
5. Create examination sessions.
6. Configure the exact subjects and maximum/passing marks for each examination.
7. Save a draft result with every configured subject mark.
8. Review the result and publish it.
9. Publish the examination itself in the database before it appears in the public examination dropdown:
   `UPDATE examinations SET publication_status='Published', result_publication_date=now(), updated_at=now() WHERE examination_id = <ID>;`
   This last step should be performed by a properly authorized operator. The starter provides examination creation/configuration but does not yet provide a dedicated examination-publication UI.

## Public result lookup
Public route:
`GET /api/public/results/:rollNumber?examination_id=<id>`

The API returns only public fields for a published result and published examination. It uses parameterized SQL, input validation, no-store caching, and rate limiting. Roll numbers may be reused in other examinations because the examination ID is part of the lookup.

## Administrator API
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/auth/me`
- `GET /api/admin/overview`
- `GET /api/admin/classes`
- `GET /api/admin/years`
- `GET /api/admin/examinations`
- `POST /api/admin/students`
- `POST /api/admin/examinations`
- `GET /api/admin/examinations/:id/subjects`
- `POST /api/admin/examinations/:id/subjects`
- `GET /api/admin/subjects`
- `POST /api/admin/results` (saves a draft; calculates totals and percentage on server)
- `POST /api/admin/results/:id/publish`
- `POST /api/admin/results/:id/withdraw`
- `GET /api/admin/audit`

All admin routes require a session and a permission check. The starter has permission seeds for future role assignment; the first administrator is assigned the Administrator role.

## Production deployment checklist
- Use a managed PostgreSQL instance or secured private database network; never expose the database publicly.
- Set `NODE_ENV=production`, `SESSION_COOKIE_SECURE=true`, a long unique `SESSION_SECRET`, and a production `DATABASE_URL` in the hosting provider's secret manager.
- Use HTTPS only. Set `PUBLIC_BASE_URL` to the canonical public URL.
- Restrict database network access to the backend.
- Run migrations as a deployment step, not from public requests.
- Create the first administrator through a one-time secure shell/console task; do not expose account creation publicly.
- Enable managed backups and test restoring one to a separate database.
- Configure provider logging, uptime monitoring, alerting, dependency scanning, and a process for security updates.
- Use a custom domain or provider deployment subdomain and verify its TLS certificate.
- Use a persistent PostgreSQL service; ephemeral container filesystem storage is not a database backup.
- Review privacy, student-data access, retention, and publication policies with the college before entering real student records.
- Set an appropriate `PGSSL=true` when connecting to a provider that requires verified TLS. Provider-specific CA setup may be necessary.
- For multiple app instances, use the PostgreSQL-backed session store already configured and set correct trusted proxy settings.
- Configure the passing policy deliberately. The starter supports per-subject passing thresholds; its aggregate mode uses a simple 33% threshold as a placeholder and must be changed to the college's officially approved rule before production.

## Backups
Example manual backup from an environment with PostgreSQL client tools:
`pg_dump "$DATABASE_URL" --format=custom --file=pnc-results-$(date +%F).dump`
Restore test to a separate database:
`pg_restore --clean --if-exists --dbname="$RESTORE_DATABASE_URL" pnc-results-YYYY-MM-DD.dump`
Store backups encrypted with restricted access and test restoration regularly. Do not commit backups to source control.

## Acceptance tests to complete before launch
- Public page opens on Android, iPhone and desktop via the same HTTPS URL.
- Admin can sign in and unauthorized visitors receive HTTP 401/403 from admin APIs.
- Valid student, exam and subject setup succeeds.
- Negative marks and marks above configured maximum are rejected.
- Missing subject marks prevent saving/publishing.
- Draft and withdrawn results are not public.
- Published results appear through the public API on a second device.
- Updating a result returns it to Draft and removes the previously published version from public search until republished.
- Duplicate roll number in the same examination is rejected.
- Reused roll numbers in different examinations are distinguished by examination ID.
- Marks, total, percentage and status match college-approved rules.
- Print/PDF output is legible on mobile and desktop.
- Backup restoration is demonstrated before real data is entered.

## Known items to finish before production handover
This project is a strong functional foundation, not a certified production deployment. A production release should add automated integration tests, CSRF protection appropriate to the chosen deployment/session setup, MFA for administrators, account lockout and recovery procedures, a full admin student/result search-and-edit interface, examination publication UI, section management, student record update/deactivation, a safer migration framework, structured observability, and independent security review. Configure and verify the college's exact passing rules and privacy policy. Do not treat generated sample data or an untested deployment as official examination records.
