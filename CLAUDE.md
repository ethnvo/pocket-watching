# Pocket Watching rules

Pocket Watching is a cracked meter: it shows how good someone is at what they do. Pay, company type, tiers and school labels are all signals of that. Every feature and prompt should serve that question.

## What we measure
- **Career moves only.** We rate jobs and programs that say something about skill. Everyday jobs (retail, food service, delivery, babysitting, lifeguarding…) aren't compared: minimum-wage pay says nothing about how good someone is. They get no badges and are never sent to Gemini (`isEverydayJob()` in `content.js`, `skip` in the job prompt).
- **Judge people in their own field.** A bio major is rated against biology programs, a finance intern against finance roles. Never score a non-CS person by CS rankings.
- **Compliments, not insults.** Only THANOS, S and A tiers are shown. Lower tiers never render. LARP is the one negative flag, and only for wildly inflated titles.

## How we show it
- **One mark, one meaning.** If a badge or check already says something, don't repeat it in text. The blue check means confirmed by you; the outlined check means community-reported. The word only appears when checks are turned off.
- **Estimates say they're estimates.** Anything not confirmed or community-reported carries `approx.`, `est. mkt`, `median` or `edited`, and its tooltip says where the number came from.
- **Keep badges short.** Detail goes in the tooltip.

## Working on the code
- After changing a Gemini prompt, bump its cache key (`JOB_CACHE`, `pay3:`, `school3:`…) so old answers re-run, and add the old prefix to the stale-key cleanup in `background.js`.
- Keep README, CONTRIBUTING and the Settings descriptions in sync with behavior.
- Run `npm test` before pushing.
