# Shop Bill Tracker

Tracks every bill through the shop's stages, with a login for each employee and the exact time of every button press.

| Step | Code | Who | Buttons |
| ---- | ---- | --- | ------- |
| 1 | R Preparing Sale Items | Adnan | Types bill no. then Start, then End |
| 2 | S Checking Sale Items | Junaid or Faraz (either one) | Start, then End |
| 3 | I Polythene Packing | Irfan | One tap (current time) |
| 4 | FR Final Ready | Computer operator | One tap (current time) |

A bill only shows up for a stage once the previous stage is finished. The owner sees every bill,
each stage's times and who did it, averages, and can download a CSV. Other work (codes A to Q,
e.g. C Basement Cleaning) can be logged from "Other Tasks".

## Run it

Needs Node.js 22 or newer (https://nodejs.org). No other installs.

    node server.js

Open http://localhost:3000 on that computer. Phones on the same Wi-Fi can open
http://<that-computer's-IP>:3000. Data is saved in `data/shop.db` (back up this one file).

Optional settings: `PORT=8080 node server.js`, `DB_FILE=/path/shop.db node server.js`.

## Put it online (Render)

`render.yaml` sets up everything: Node 22, a 1 GB disk at /var/data so the data survives restarts
and redeploys, and Singapore region (closest to India). Cost is the Starter plan, $7/month, plus
$0.25/month for the disk. Render backs up the disk daily.

1. Push this folder to a GitHub repository.
2. On render.com: New > Blueprint, pick the repository, Apply.
3. Open the `https://bill-tracker-xxxx.onrender.com` link it gives you and log in as admin.

## Logins

Owner: **admin** / admin123 (change it from the Password button).

Staff: every employee logs in with their name in lowercase (e.g. `adnan`, `junaid`, `vicky`) and password 1234.
Bill steps and codes: PR Preparing Sale Items (ADNAN), CH Checking Sale Items (JUNAID, FARAZ),
PK Polythene Packing (IRFAN), FR Final Ready (the 12 computer operators). Change these under **Staff**.

Work Tasks (everyone, tap to start, End to stop): A 1st Floor, B 3rd Floor, C Basement Cleaning,
D Basement Setting, E Bill Distribution, F Expiry Preparations, G Floor Maintenance, H Local Poly Distribution,
I Polythene Packing, J Purchased Goods Setting, K Rack Checking, L Rack Setting, M Sale Goods Check,
N Sorting Short Items, O Syrup Cases, P Transport Check, Q Tube Rack Setting, R Sitting Idle,
S Ground Floor Cleaning, T Break. The owner sees them all under **Task Log**.

The owner can add staff, reset passwords, and change who does which stage under **Staff**,
and add new short codes under **Task Codes**. Mistakes can be fixed in **All Bills**: click a
bill row, then "Undo" a stage.
