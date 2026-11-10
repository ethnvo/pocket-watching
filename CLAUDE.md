# Pocket Watching rules

Pocket Watching is a cracked meter: it shows how good someone is at what they do. Pay, company type, tiers and school labels are all signals of that. Every feature and prompt should serve that question.

## What we measure
- **Career moves only.** We rate jobs and programs that say something about skill. Everyday jobs (retail, food service, delivery, babysitting, lifeguarding…) aren't compared: minimum-wage pay says nothing about how good someone is. They get no badges and are never sent to Gemini (`isEverydayJob()` in `content.js`, `skip` in the job prompt).
- **Judge people in their own field.** A bio major is rated against biology programs, a finance intern against finance roles. Never score a non-CS person by CS rankings.
- **Compliments, never put-downs.** Comparing the top is fun: A vs S vs THANOS is fair game. Calling someone B, Mid, C or D tier is demeaning, so it never happens on screen, in any form:
  - Only THANOS, S and A tier chips render. Lower tiers exist internally to place the top accurately, and never show.
  - No indirect put-downs either. Labels and tooltips are neutral or positive: no "Top 200", "lesser-known", "unranked", "low-tier". A school label past the top 50 is either neutral ("UC", "Community college") or absent (`putsDown()` in `content.js`).
  - No badge at all is the default. Most entries get nothing, and that's never a statement about the person.
  - LARP is the one negative flag, and only for wildly inflated titles, never for ordinary ones.
- **Hype up, never belittle.** This covers companies, schools and categories too, not just people. Hyping something ("the AI-era answer to FAANG") is fine. Putting something down to do it is not: no "lowkey fell off", "lost its credibility", "a step below", "-lite". Name categories by what they are next to, not what they fall short of (FAANG-adjacent, not FAANG-lite).
- **Light teasing is fine when it's about something trivial**, like how long school took ("Super senior", "SUPER DUPER SENIOR" stay). Never about skill, pay or worth. LARP reasons tease the title, never the person, and stay playful, not harsh.

## How we show it
- **One mark, one meaning.** If a badge or check already says something, don't repeat it in text. The blue check means confirmed by you; the outlined check means community-reported. The word only appears when checks are turned off.
- **Estimates say they're estimates.** Anything not confirmed or community-reported carries `approx.`, `est. mkt`, `median` or `edited`, and its tooltip says where the number came from.
- **Keep badges short.** Detail goes in the tooltip.

## Working on the code
- After changing a Gemini prompt in a way that makes old answers wrong, bump its cache key (`JOB_CACHE`, `pay3:`, `school4:`…) so they re-run, and add the old prefix to the stale-key cleanup in `background.js`. A plain rename can be aliased where it's displayed instead (see `FAANG-lite`).
- Keep README, CONTRIBUTING and the Settings descriptions in sync with behavior.
- Run `npm test` before pushing.
