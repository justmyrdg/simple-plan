# Data Privacy (RA 10173) in TrashWatch

TrashWatch stores residents' names and mobile numbers and takes camera photos, so the Data Privacy
Act of 2012 applies. This page lists what the system does about it and what you still need to do.
It's a technical summary, not legal advice. Have it reviewed by your adviser or your institution's
Data Protection Officer (DPO).

## Built into the system

| Principle | How TrashWatch handles it |
|---|---|
| **Consent** | An admin can't add a resident without ticking "The resident agreed to receive SMS pickup reminders…". The consent date is stored and shown on the Contacts list. |
| **Withdrawing consent** | Residents stop SMS themselves at **/stop** (no login). Every SMS includes the link when `PUBLIC_URL` is set. Admins can't switch an opted-out resident back on without confirming new consent. |
| **Transparency** | A public **Privacy notice** at **/privacy**, linked from the public page and /stop. Fill in `ORG_NAME` and `PRIVACY_CONTACT` in `backend/.env`. |
| **Proportionality** | Only name, mobile number and area are stored. Photos are saved only when an area's status changes, not continuously. |
| **Retention** | Camera photos are deleted automatically after `PHOTO_RETENTION_DAYS` (default 30). |
| **Not revealing who is registered** | /stop gives the same answer whether or not a number is on the list. |
| **Access control** | Admin pages, camera video and photos require login. Passwords are hashed with bcrypt. |
| **Right to erasure** | Deleting a contact removes the name and number. Their SMS log entries keep only a masked number (`09•••••2233`), so report counts stay correct. |

## What you still need to do

1. **Use HTTPS.** Without it, logins and photos travel unencrypted. Get a domain (a free one from
   DuckDNS works), point it at the EC2 IP, then run:
   `sudo bash deploy/setup_ec2.sh your.domain.com you@email.com`
2. **Set the notice details** in `backend/.env`:
   ```
   ORG_NAME=Barangay ___ / Batangas City ENRO
   PRIVACY_CONTACT=dpo@example.com or 0917...
   PUBLIC_URL=https://your.domain.com
   ```
3. **Point cameras at the collection point only**, not at houses, windows or where people gather.
   Put up a visible "CCTV in operation" sign at each monitored point.
4. **Collect consent properly.** Use a short paper or online form that residents sign or tick,
   stating the purpose (pickup reminders) and that they can stop at any time. Keep the forms.
5. **Restrict admin accounts** to people who need them, and use strong passwords.
6. **Back up the database securely.** It contains personal data, so don't put it on GitHub. The
   `.gitignore` already excludes it.
7. Ask your adviser or DPO whether the deployment needs **NPC registration** or a privacy impact
   assessment.

## For the thesis

In the methodology or ethics section, describe:
- the consent process
- the privacy notice
- photo retention
- opt-out
- camera placement
- HTTPS

The table above can be used directly.
