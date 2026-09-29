# Privacy policy

_Last updated: September 29, 2026_

Pocket Watching is a Chrome extension that adds pay and company context to LinkedIn profiles you open. It has no server and no accounts, and the developer never receives any of your data.

## What it reads

When you open a LinkedIn profile, the extension reads the Experience and Education entries shown on that page, plus the person's name and headline.

## What leaves your browser

- **To Google Gemini, using your own API key:** the text of each entry being looked up (title, company, dates, location, description) and the profile's headline and Education section. This is how pay and company details are estimated. Google processes it under its [Gemini API terms](https://ai.google.dev/gemini-api/terms) and privacy policy.
- **From GitHub:** the extension downloads the public `community-pay.json` file about once a day. Nothing is sent.

Nothing else is sent anywhere. There's no analytics, tracking, advertising or selling of data.

## What's stored

Everything is stored locally in your Chrome profile:
- your Gemini API key and settings (Chrome sync storage, which syncs to your other Chrome browsers if you use Chrome Sync)
- pay you confirm, and lookup results (cached so revisited profiles don't get sent again)

You can clear lookup results in Settings → Data, or remove everything by uninstalling the extension.

## Changes and contact

Changes to this policy will be committed to this repository. For questions, open an issue at https://github.com/ethnvo/pocket-watching/issues.
