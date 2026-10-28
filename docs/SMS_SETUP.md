# SMS Setup

TrashWatch texts residents before each scheduled pickup, in **English or Filipino** (set per resident),
and texts admins when a pickup was **not collected**. Without any provider configured, SMS is
**simulated**: messages are only logged on the SMS log page.

## Option A: free, with an Android phone (recommended)

An Android phone with a SIM sends the texts through the free **SMS Gateway for Android** app
(sms-gate.app). You only pay for the SIM's load. An **unlimited-text promo** from Globe, Smart, TM
or TNT covers a barangay's reminders.

1. Install **SMS Gateway for Android** on the phone. See the app's installation page:
   https://docs.sms-gate.app/installation/
2. Open the app and switch on **Cloud Server**.
3. Tap **Offline**. It changes to **Online** once the phone is connected.
4. The **username** and **password** appear in the app's **Cloud Server** section.
5. On the server, put them in `backend/.env` (on EC2: `/opt/trashwatch/backend/.env`):
   ```
   SMSGATE_USERNAME=the username from the app
   SMSGATE_PASSWORD=the password from the app
   ```
6. Restart the backend (`sudo systemctl restart trashwatch` on EC2).
7. Test: open an area → **Contacts** → click the send icon next to a resident. The phone sends the
   test SMS, and the SMS log shows it as `sent`.

Keep the phone **on, charged and connected** (Wi-Fi or mobile data), and keep the app running.
Telcos have fair-use limits on unlimited-text promos. That's fine for reminders, but don't use it for
mass blasting.

## Option B: Semaphore (paid, Philippine SMS gateway)

1. Sign up at https://semaphore.co, buy credits and copy your **API key**.
2. In `backend/.env`:
   ```
   SEMAPHORE_API_KEY=your key
   SEMAPHORE_SENDER_NAME=        # only if Semaphore approved a sender name for you
   ```
3. Restart the backend.

If both options are configured, `SMS_PROVIDER=smsgate` or `SMS_PROVIDER=semaphore` picks one.

## Other SMS settings

| Setting | What it does |
|---|---|
| `ADMIN_PHONES=09171234567,09181234567` | Numbers that get an SMS when a scheduled pickup was not collected |
| `PUBLIC_URL=https://your-site` | Adds an opt-out link (`<PUBLIC_URL>/stop`) to every resident SMS |

## Time zone (important on EC2)

Pickup times are Philippine time. EC2 servers run on **UTC** by default, which would send reminders
**8 hours late**. `deploy/setup_ec2.sh` sets the server to `Asia/Manila` automatically. On a server
set up before this change, run:

```bash
sudo timedatectl set-timezone Asia/Manila
sudo systemctl restart trashwatch
date        # should show PST
```

## Message examples

English:
> TrashWatch: Garbage truck pickup at Purok 1 today at 8:00 AM. Please bring out your trash. Truck: Truck 3. Biodegradable only. To stop: https://your-site/stop

Filipino:
> TrashWatch: Darating ang trak ng basura sa Purok 1 bukas ng 8:00 AM. Pakilabas na po ang inyong basura. Trak: Truck 3. Para huminto: https://your-site/stop

The schedule's **notes** (e.g. "Biodegradable only") are added to the message. That supports
segregated collection days under RA 9003. Messages longer than 160 characters are sent as 2 SMS
parts, which costs 2 credits on Semaphore.
