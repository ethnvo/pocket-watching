# Contributing

## Add your pay to community pay

Community pay is a list of real offers in [`community-pay.json`](community-pay.json). Everyone running Pocket Watching gets it (it refreshes about once a day), and it shows up with an outlined check and a "community" tag. It's the closest thing this project has to a database of verified internships: every entry is a pull request someone reviewed.

**Rules**
- Only real offers: yours, or someone's who said it's okay.
- No names, emails or anything that identifies a person. The file doesn't even have a field for it.
- Pay is location-specific. An Amazon offer in Seattle only covers Seattle, so always include the location.
- Internships: use `hourly`, or `monthly` if the offer quoted a monthly salary. Full-time: use `annual` total compensation (base + stock per year + bonus).

**Add an entry**

The easiest way is to [edit the file on GitHub](https://github.com/ethnvo/pocket-watching/edit/main/community-pay.json), add an object to the list and open a pull request.

```json
{
  "company": "Amazon",
  "role": "SDE Intern",
  "location": "Seattle, Washington",
  "monthly": 9400,
  "housing": 2900,
  "housing_period": "month",
  "intern": true,
  "source": "Fall 2026 offer",
  "contributor": "your-github-handle"
}
```

| Field | Required | Notes |
|---|---|---|
| `company`, `role`, `location` | yes | As they appear on LinkedIn |
| `hourly` / `monthly` / `annual` | exactly one | Numbers, no `$` or commas |
| `intern` | yes | `true` or `false` |
| `source` | yes | What it's from, e.g. `"Summer 2026 offer"` |
| `housing`, `housing_period` | no | `"month"` for a monthly stipend, `"total"` for a lump sum |
| `reference` | no | `true` if you're not sure. It'll only be used as a hint, never shown as an offer |
| `contributor` | no | Your GitHub handle, if you want credit |

Before opening the PR, run `node scripts/validate-community.mjs`. The same check runs on every pull request.

Evidence is optional. If you include any, redact everything personal. A cropped screenshot or a Levels.fyi link is plenty; never post a full offer letter.

## Code changes

There's no build step. Edit the files, reload the extension in `chrome://extensions` and refresh LinkedIn.

- `content.js` finds entries on LinkedIn and draws badges. LinkedIn changes its markup often, so `findEntries()` is the usual suspect when badges disappear.
- `background.js` handles Gemini calls, pay rules, known and community pay, and caching.
- `options.*` is the settings page.

Keep the spirit of the project: pay transparency and a joke, never a way to demean anyone.
