# CV Blaster 0.1.1 — Runtime Fixes

This source package is based on the previous Codespaces-ready project and fixes the issues observed in the Windows runtime test.

## Fixed

- Candidate DOB is stored as three editable fields: `dateOfBirthDay`, `dateOfBirthMonth`, and `dateOfBirthYear`, plus canonical `dateOfBirth` (`YYYY-MM-DD`) when complete.
- Local profile edits are persisted unconditionally to localStorage; DOB no longer resets just because Google Sheets/search fields are empty.
- Server config normalization persists and clamps application limits to a hard maximum of 50.
- The shared limit and all per-platform limit inputs are capped at 50 in the UI and normalized server-side.
- Explicit config overrides now honor empty values, so clearing a DOB field really clears it for the running bot.
- JobStreet questionnaire answering no longer reuses stale generic `Select option` / `Select options` knowledge-base rows.
- DOB day/month/year answers are deterministic from the profile; Gemini is not used to guess DOB.
- Yes/No experience questions use configured candidate evidence before Gemini and avoid unsupported positive claims.
- Generic checklist groups are not hallucinated; available “None” options are used when appropriate, otherwise the bot can leave optional groups unchecked.
- Job-specific language checklist answers can use the new `languages` profile field.
- JobStreet navigation uses `domcontentloaded` instead of `networkidle2` for job/search navigation to reduce false 45-second navigation timeouts.
- JobStreet questionnaire page evaluations retry transient “Execution context was destroyed” navigation errors.
- External JobStreet application paths are classified as `Skipped (External)` or `Skipped (External / Daftar)` before/after clicking, recorded in Google Sheets, and never counted as successful applications.
- Senior job titles are conservatively rejected by the local eligibility gate when the configured experience is below 2 years.
- The Windows build uses Webpack and includes a production bundle verification step for Puppeteer external-module references.

## Existing features preserved

The package retains the existing platform toggles, shared/per-platform quota UI, debug mode, browser engine selection, Gemini configuration, Google Sheets integration, Import/Export JSON, template profiles, questionnaire database, eligibility gate, JobStreet cover-letter generation, and headful/headless operation.

The available previous packaged source was used as the comparison baseline. No additional removed feature was fabricated or invented where the baseline did not provide evidence.
