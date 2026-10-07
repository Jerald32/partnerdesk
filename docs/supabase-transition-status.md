# Supabase transition status

## Local changes and database dependency

`20261008000000_add_business_partner_unlink.sql` was already applied remotely
in the earlier authorized operation. It has not been changed in this batch.

`20261008000001_complete_app_workflows.sql` was applied remotely after the user's
final review/application authorization. The CLI dry-run selected only this file;
history matches through this version. All eight remote function bodies and their
ownership/EXECUTE permissions were checked against the migration. No business
records were changed as an application test during migration application.
The user subsequently confirmed the core workflows, admin permissions, User
Management menu and Partner creation in browser smoke testing on 2026-10-08.
Existing role-management and Partner create/update RPCs remain unchanged.

New public RPCs:

- `update_business(uuid,text,text,boolean,timestamptz)`
- `update_service_partner_terms(uuid,text,numeric,numeric,timestamptz)`
- `update_ticket_address(uuid,text,text,integer)`
- `change_ticket_operator(uuid,boolean,integer)`
- `update_my_profile(text,text,text)`
- `mark_notifications_read(uuid DEFAULT NULL)`
- `read_admin_audit(text,integer DEFAULT 0)`

All writes reuse the current app-session and role guard. Business and relation
edits compare `updated_at`; Ticket writes compare `version` and reject anonymized
records. Operators claim unassigned Tickets or release their own assignment;
admins can explicitly take over or release another operator's assignment.
No automatic assignment happens when reading. Write audit failures roll back
the transaction. Audit reads are admin-only, session-validated, no-touch and
bounded to 100 rows; the audit schema is not exposed through table grants.

## Runtime inventory

- Dashboard, Business list/create/detail/relations, Ticket list/create/detail,
  status, Activity and Partner assignment retain the existing Supabase flows.
- Partner list/detail/create/edit now use organizations/partner_details and the
  existing `create_partner`/`update_partner` RPCs. Only admins can create/edit.
- User list, role/organization changes, disable, suspended-account reactivation,
  and pending-request approve/reject use RLS and existing management RPCs.
- Account fields and role requests use RPCs. Role-request organization options
  come only from RLS-readable active organizations; no guest directory access
  or organization permissions have been added.
- Partner privacy consent uses `record_privacy_consent`; existing AuthContext
  decides whether the gate can open. Login/session issuance remains unchanged.
- Notifications use the recipient Profile and the new own-notification RPC.
- Settings show actual RLS-readable values. MFA/IP switches remain read-only
  because changing them without the matching auth integration can lock users out.
- Access/role/deletion audit pages use the new bounded admin read RPC.

## Deliberately unavailable

- Registration and password recovery/reset, MFA login UI, email verification UI,
  Auth user invitations/deletion/provisioning: legacy flows are archived. A server
  Auth administration/provisioning flow and configuration are required; frontend
  service-role administration is not a substitute. Existing working login is
  unchanged.
- Guest onboarding/organization discovery is still closed by the existing gate.
- Ticket attachment upload/download, Partner logo and profile image uploads were
  not active routes/features in the running app. Old UploadFile code is archived;
  no Storage bucket or permissive policy has been introduced. Existing historical
  files have not been transferred or deleted.
- Audit backups/exports, automated notifications/retention, OAuth/MCP integration
  and security-setting writes are not activated by this batch. Existing audit
  records and server automation definitions remain untouched.
- Business/Partner/Ticket hard deletion is not added.

## Validation scope

Lint/build/import-graph and diff checks cover the active application. Browser
smoke-test results above were reported by the user, not independently reproduced
by the agent. This does not claim exhaustive testing of every RPC. Historical code in
`legacy/base44/src` is reference material and is excluded from runtime validation.
