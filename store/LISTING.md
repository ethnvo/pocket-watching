# Chrome Web Store listing

Copy-paste material for the Chrome Web Store developer dashboard.

## Name
Pocket Watching

## Short description (≤132 characters)
Pay, company type and a little context under the career moves on a LinkedIn profile. Made for fun and pay transparency.

## Category
Productivity (alternative: Social & Communication)

## Detailed description
Pocket Watching adds small badges under the jobs and schools on a LinkedIn profile:

• Pay: hourly or monthly for internships, total compensation for full-time roles, housing stipends. Pay you've confirmed yourself gets a blue check; everything else is clearly labeled as an estimate.
• Company type: MANGO, FAANG, Quant, Fintech, Startup (with its funding round), Unicorn (with its valuation and source), Y Combinator batch, Student org and more.
• Compliments: THANOS, S and A tier for standout roles. Lower tiers are never shown.
• School context: program tier and how long undergrad took.
• Community pay: real offers people submitted to the open-source repo.

Everyday jobs (cashier, barista, retail, food service) are left alone.

It uses Google Gemini with your own free API key. It has no server and no accounts, and your data stays in your browser.

Made as a joke, and for pay transparency. Don't use it to spread hate or demean anyone.

Open source (MIT): https://github.com/ethnvo/pocket-watching

## Single purpose
Shows pay and company context next to the experience and education entries on LinkedIn profiles the user opens.

## Permission justifications
- **storage:** saves the user's settings, the pay they confirm, and cached lookups so revisited profiles don't need another API call.
- **Host permission, generativelanguage.googleapis.com:** sends the entry being looked up to the Google Gemini API (with the user's own key) to estimate pay and company details.
- **Host permission, raw.githubusercontent.com:** downloads the public community-pay.json data file (data only, no code) about once a day.
- **Content script on linkedin.com:** reads the Experience and Education entries on profiles the user opens and draws the badges.

## Remote code
No. The extension only downloads a JSON data file; all code ships in the package.

## Data usage (privacy practices tab)
- Collected: **Website content** (the text of LinkedIn entries being looked up). It's sent to Google Gemini to provide the feature, and isn't collected by the developer.
- Not sold, not used for anything unrelated to the feature, not used for creditworthiness or lending.
- Privacy policy URL: https://github.com/ethnvo/pocket-watching/blob/main/PRIVACY.md

## Assets you still need to make
- **Screenshots** (at least 1, 1280×800 or 640×400): take them on your own LinkedIn profile, not someone else's.
- **Small promo tile** (440×280), optional.
- Icon: `icons/128.png`, already in the repo.
