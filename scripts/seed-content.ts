/**
 * Puts the starting help articles and the Terms and Privacy pages into the database, only where they don't exist yet.
 * It never overwrites anything staff have edited. Run it once per environment:  npx tsx --env-file=.env scripts/seed-content.ts
 *
 * The wording is a sensible starting point written to match how ShopCore really works (M-Pesa and cash on delivery, a 14-day
 * return window, riders, delivery codes). Have your own legal adviser read the Terms and Privacy pages before launch, and edit
 * everything in the admin under Support > Help centre and Marketing > Pages.
 */
import pg from 'pg';
import { uuidv7 } from '../src/infra/uuid.js';

const ARTICLES: { title: string; category: string; body: string }[] = [
  { category: 'Orders & delivery', title: 'How do I track my order?', body: 'Open Orders in the app and tap your order. You will see each step as it happens: placed, paid, packed, on the way and delivered. When your rider is on the road you can see where they are and you will find your delivery code, which you read out to the rider at your door.' },
  { category: 'Orders & delivery', title: 'Can I change my delivery address?', body: 'Tell us before the order is packed. Open the order, choose Get help and send us the new address. Once a rider has collected your parcel the address can no longer be changed.' },
  { category: 'Orders & delivery', title: 'How long does delivery take?', body: 'Most orders in Nairobi arrive the same or the next working day. When you choose your delivery area at checkout you see the delivery fee for it. You will get an update in the app when your order is on its way.' },
  { category: 'Orders & delivery', title: 'What is the delivery code?', body: 'When your rider has your parcel, the app shows a 4-digit delivery code on the tracking page. Give it to the rider when they arrive. It proves the right person received the order. Never share it before the rider is at your door.' },
  { category: 'Orders & delivery', title: 'How do I cancel an order?', body: 'You can cancel an order from its page until a rider has collected it. If you already paid, we return your money to you once the cancellation is processed. After the parcel is on its way, please refuse delivery or contact support.' },
  { category: 'Returns & refunds', title: 'What is the return policy?', body: 'You can return an item within 14 days of delivery if it arrived damaged, is not what you ordered, or is not as described. Open the delivered order and choose Request a return. Choose the items, give a reason and add photos where it helps. We review requests within one working day.' },
  { category: 'Returns & refunds', title: 'When will I get my refund?', body: 'Once a refund is approved it is sent back the way you paid. M-Pesa refunds usually reach you within one working day. You can follow the status on the order page under Refund status.' },
  { category: 'Payments', title: 'Which payment methods can I use?', body: 'You can pay with M-Pesa or choose cash on delivery at checkout. With M-Pesa you get a prompt on your phone: enter your PIN to pay. With cash on delivery you pay the rider when your order arrives.' },
  { category: 'Payments', title: 'My M-Pesa prompt did not arrive. What now?', body: 'Check that the number is correct and that your phone has signal, then choose Resend. If money left your account but the order still shows as unpaid, wait a few minutes and refresh. If it is still unpaid, contact support with your M-Pesa message and we will fix it.' },
  { category: 'Account & security', title: 'How do I change my password?', body: 'Open Profile, then Settings, then Security and choose Change password. You will need your current password.' },
  { category: 'Account & security', title: 'How do I delete my account?', body: 'Open Profile, then Settings, then Security and choose Delete account. Deleting is permanent: it removes your sign-in, saved addresses and preferences. We keep the records of past orders that we must keep for accounting.' },
];


const RIDER_ARTICLES: { title: string; category: string; body: string }[] = [
  { category: 'Rider · Deliveries', title: 'How do I get orders?', body: 'Open Home and tap Go online. Keep the app open and your location on. When an order is sent to you, a request appears with the pickup, the drop-off, what you will earn and a 75-second countdown. Tap Accept to take it. If you do not answer in time, the order goes to another rider.' },
  { category: 'Rider · Deliveries', title: 'What are the steps of a delivery?', body: 'After you accept: go to the pickup and tap I have arrived, check every item against the list and confirm the pickup, then head to the customer and tap I have arrived. At the door, take an optional photo, collect the cash if it is a cash order, and enter the 4-digit code the customer reads from their app. The order is then complete and your earnings are added.' },
  { category: 'Rider · Deliveries', title: 'What is the customer’s 4-digit code?', body: 'The customer sees a 4-digit code in their app once you have collected their order. You must ask them for it at the door and enter it to complete the delivery. It proves the order reached the right person. Never complete a delivery without it, and never give your own code to anyone.' },
  { category: 'Rider · Deliveries', title: 'The customer is not answering. What do I do?', body: 'Call them from the app. If you still cannot reach them, tap Can’t reach the customer. After the 5-minute wait you can mark the delivery as failed with a reason. Keep the order safe and wait for dispatch to tell you what to do with it.' },
  { category: 'Rider · Deliveries', title: 'An item is missing or damaged. What now?', body: 'Do not leave the store with an order you cannot complete. Tap Something not available on the checklist, or Report a problem, and describe what is wrong. Dispatch will contact you.' },
  { category: 'Rider · Cash and payouts', title: 'How do cash on delivery orders work?', body: 'For a cash order the app shows the exact amount to collect. Collect that amount, count it, and confirm it before the customer’s code. The cash belongs to ShopCore: it appears under Cash balance as cash with you until you hand it in.' },
  { category: 'Rider · Cash and payouts', title: 'How do I hand in cash?', body: 'Open Earnings, then Cash balance, then How to hand in cash. Follow the instructions shown there. When ShopCore records your hand-in, the amount clears from your cash balance and you will see it in the list of movements.' },
  { category: 'Rider · Cash and payouts', title: 'How do I withdraw my earnings?', body: 'Open Earnings and tap Withdraw earnings. Enter an amount up to your balance minus the withdrawal fee. The money is set aside immediately and ShopCore finance sends it to your M-Pesa number. Follow the status under Payout history. If a payout fails, the money returns to your balance.' },
  { category: 'Rider · Cash and payouts', title: 'How do I change my M-Pesa number?', body: 'Open Profile, then Payout settings, then Change M-Pesa number. You will be asked for your password. The number must be registered in your own name.' },
  { category: 'Rider · Documents', title: 'Which documents do I need?', body: 'Every rider gives a national ID (front and back), a selfie, a photo of the vehicle, a KRA PIN certificate with the PIN, and a certificate of good conduct. Motorbike and car riders also give a driving license and insurance (each with its expiry date) and the vehicle logbook. Bicycle riders do not need the license, insurance or logbook.' },
  { category: 'Rider · Documents', title: 'My document was turned down. What now?', body: 'Open Profile, then Vehicle and documents, and tap the document marked Turned down. Read the reason, then send a clear new photo in good light with all four corners showing.' },
  { category: 'Rider · Documents', title: 'My license or insurance is about to expire', body: 'Renew it before the date. Open Vehicle and documents, tap the document and send the new copy with its new expiry date. If a document expires you cannot go online until a new one is approved.' },
  { category: 'Rider · Safety', title: 'What do I do in an emergency?', body: 'Open Profile and tap SOS. Your location is sent to ShopCore dispatch straight away and the team will contact you. Call the national emergency number 999 or 112 first if anyone is hurt or in danger. For an accident that is not an emergency, use Report an accident.' },
  { category: 'Rider · Training', title: 'Lesson 1: Handling an order with care', body: 'Check every item against the list before you leave the store. Keep cold and fragile items upright and separate from heavy ones. Use the bag the store gives you and keep it closed until you hand it over. If anything is missing or damaged, report it before you ride, not at the customer’s door.' },
  { category: 'Rider · Training', title: 'Lesson 2: Cash on delivery, safely', body: 'For cash orders the app shows the exact amount. Count the cash in front of the customer, never ask for more, and never give change from your own money. Keep cash separate from your own and hand it in as soon as you can. Never carry large amounts for long.' },
  { category: 'Rider · Training', title: 'Lesson 3: Road safety basics', body: 'Wear a helmet, keep to the speed limits and give way at junctions. Do not use your phone while the vehicle is moving: stop in a safe place to read the app. Ride slower in rain and at night, and keep your lights and brakes in good order.' },
  { category: 'Rider · Training', title: 'Lesson 4: Dealing with a difficult customer', body: 'Stay calm and polite. If the customer cannot be reached, call them from the app and wait the full 5 minutes before marking the delivery as failed. If you feel unsafe at any point, leave and report it from Report a problem or use Emergency SOS.' },
  { category: 'Rider · Safety', title: 'Ride safely', body: 'Obey traffic laws, wear your helmet, and never use your phone while the vehicle is moving. Pull over safely before you read messages or check the route. No delivery is worth an accident.' },
];

const TERMS = `These terms explain how you can use ShopCore and what to expect when you shop with us.

1. Using ShopCore
By using the ShopCore app you agree to these terms. You must be at least 18 years old, or use the app with a parent or guardian's permission.

2. Orders and payments
Prices are in Kenyan shillings. An order is confirmed when your payment is received (M-Pesa) or when we accept it (cash on delivery). Stock and prices can change; the price you see at checkout is the price you pay. If an item cannot be supplied we will tell you and refund anything you paid for it.

3. Delivery
Delivery fees and areas are shown at checkout. Someone must be available to receive the order and to give the rider the delivery code. If a delivery fails because nobody could be reached, we may charge to try again.

4. Returns and refunds
You may return eligible items within 14 days of delivery. Refunds are sent back the way you paid once a return or refund request is approved.

5. Your account
Keep your sign-in details private. You are responsible for activity on your account. Tell us at once if you think someone else is using it.

6. Contact
Questions about these terms? Contact support from the Help section of the app.`;

const PRIVACY = `This policy explains what information ShopCore collects, how we use it and the choices you have.

Information we collect
Your name, phone number, email and delivery addresses; your orders and payments; the photos you attach to a return; and, if you allow it, your phone's location, which stays on your phone and is used only to suggest your delivery area.

How we use it
To take and deliver your orders, take payment, answer your support requests, send you updates you have asked for, and keep ShopCore safe from fraud.

Sharing
We share your name, phone number and delivery address with the rider delivering your order. Payments are handled by our payment provider. We do not sell your information.

Your choices
You can change your details and notification choices in Profile at any time. You can delete your account from Profile > Settings > Security.

Keeping it safe
Your password is stored securely and never in plain form, and sign-ins are protected against repeated guessing.

Contact
For privacy questions, contact support from the Help section of the app.`;


const RIDER_TERMS = `These terms explain how you work as a rider with ShopCore.

1. Working with ShopCore
You are an independent partner. You choose when to go online and which requests to accept. You must be at least 18 and hold the documents we ask for, and keep them valid.

2. Deliveries
Collect and deliver orders with care, check items at pickup, and complete each delivery with the customer’s 4-digit code. Do not hand an order to anyone else.

3. Cash on delivery
Cash you collect belongs to ShopCore. You must hand it in as instructed in the app. Withholding cash can lead to your account being suspended.

4. Earnings and payouts
Your earnings for each delivery are shown in the app. You may withdraw your balance to your registered M-Pesa number, less the withdrawal fee shown. ShopCore pays withdrawals; a failed payout returns to your balance.

5. Safety and conduct
Follow road safety laws and treat customers and staff with respect. Report accidents and incidents in the app.

6. Suspension
ShopCore may pause or end an account that provides false information, breaks these terms or puts people at risk.

7. Changes
We may update these terms. The version in the app is the current one.`;

const RIDER_PRIVACY = `This policy explains what ShopCore collects about you as a rider and why.

What we collect
Your name, phone number, email, county, national ID number, KRA PIN, emergency contact, M-Pesa payout details, photos of your documents and a selfie. While you are online and on a delivery we collect your location.

Why we use it
To verify who you are, match you with orders, guide and track deliveries, pay you, keep riders and customers safe and meet our legal duties.

Who sees it
Our rider team and support staff see your documents and details. Customers see your first name, vehicle and phone number only during their delivery.

How long we keep it
We keep your records for as long as your account is active and as long as the law requires afterwards.

Your choices
You can update your email, emergency contact and payout number in the app. To change your name, phone or ID details, or to close your account, contact rider support.`;

const PAGES = [
  { title: 'Terms of service', slug: '/terms', body: TERMS },
  { title: 'Privacy policy', slug: '/privacy', body: PRIVACY },
  { title: 'Rider terms', slug: '/rider-terms', body: RIDER_TERMS },
  { title: 'Rider privacy policy', slug: '/rider-privacy', body: RIDER_PRIVACY },
];

async function main() {
  const url = process.env.DATABASE_URL?.replace(/\s+#.*$/, '');
  if (!url) throw new Error('DATABASE_URL is not set');
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    let a = 0;
    for (const x of [...ARTICLES, ...RIDER_ARTICLES]) {
      const r = await client.query('INSERT INTO help_articles (id, title, category, body, live, author) SELECT $1,$2,$3,$4,true,$5 WHERE NOT EXISTS (SELECT 1 FROM help_articles WHERE title = $2)', [uuidv7(), x.title, x.category, x.body, 'ShopCore']);
      a += r.rowCount ?? 0;
    }
    let p = 0;
    for (const x of PAGES) {
      const r = await client.query(
        `INSERT INTO content_pages (id, title, slug, audience, status, body, seo_title, seo_desc, updated_by) SELECT $1,$2,$3,'Website and mobile app','published',$4,$2,'','ShopCore' WHERE NOT EXISTS (SELECT 1 FROM content_pages WHERE slug = $3)`,
        [uuidv7(), x.title, x.slug, x.body]);
      p += r.rowCount ?? 0;
    }
    console.log(`Added ${a} help articles and ${p} pages (existing ones were left alone).`);
  } finally {
    await client.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
