# Testing Rotation

The app has no build step and no test framework, so the tests match: plain files you can run anywhere.

| Layer | File | How to run | What it covers |
| --- | --- | --- | --- |
| Unit | `tests/index.html` | Serve the repo with any static server and open `/tests/index.html` | Pure logic in `lib.js` (23 tests): taste comparison, yearly recap, recommendation merging, search query building and escaping, album-type labels, divisive-album rule, MusicBrainz paging window |
| Database flows | `tests/db-flows.sql` | Paste into the Supabase SQL editor (or any SQL runner). It always rolls back and prints results in the error message | Rating persistence, duplicate prevention, aggregates, edit/remove, listening status, public lists seen by another user, follow + feed, and that one user cannot modify another's data (run as the real `authenticated` and `anon` roles, so row-level security applies) |
| API security | `tests/security-check.ps1` | `powershell -File tests/security-check.ps1` | With only the public key: private tables return nothing, public views leak no user ids or emails, writes and signed-in-only functions are refused |
| Client flows | `tests/client-flows.js` | Paste into the browser console on the running app. It swaps the database client for a recording stub (nothing is written) and drives the real album page | 43 checks: tapping a score saves only the score, a failed save reverts and explains, saving a review omits sharing flags, removing a rating resets the page, Listened / Want / Favorite / Rated never contradict each other, signed-out taps open sign-in instead of writing, Follow and Unfollow call the checked server functions and update the count, profile setup validates and starts private, list creation, the report dialog, and password reset (forgot password and the new-password step, with the auth client stubbed so no email is sent) |
| Manual UI | the checklist below | A person, in a browser | Everything that needs a real sign-in |

## The 12 end-to-end flows

"Run" means it was actually executed. "Not run" means it still needs a person: creating accounts and signing in on the live
database from an automated session isn't something to do on someone else's behalf, so those flows are covered at the database
level only.

| # | Flow | Status |
| --- | --- | --- |
| 1 | A visitor discovers and searches for an album | Run in a browser, signed out (home, search with filters, browse, surprise, direct URLs) |
| 2 | A user creates an account and signs in | **Not run** (manual) |
| 3 | A user rates an album | Database level run (`db-flows.sql`). Page logic run against a stub (`client-flows.js`). Real sign-in UI **not run** |
| 4 | The rating persists after a refresh | Database level run (re-read in a new statement). UI **not run** |
| 5 | Community average and count update | Database level run: 1 rating, 2 ratings, after edit, after removal |
| 6 | A user edits or removes their rating | Database level run. Remove path run against a stub (`client-flows.js`). Real sign-in UI **not run** |
| 7 | A user saves an album to their library | Database level run (`album_status.want`). UI **not run** |
| 8 | A user creates a public list and adds albums | Database level run. UI **not run** |
| 9 | Another user visits the list | Database level run (second user and anon both see the public list, not the private one) |
| 10 | A user follows another user and sees activity | Database level run (follow, then the feed shows their rating and new public list). UI **not run** |
| 11 | An album or profile opens from a direct URL | Run in a browser at 390, 768 and 1280 px (reload on each URL) |
| 12 | Unauthorized users cannot modify others' data | Run at the database and API level (`db-flows.sql`, `security-check.ps1`) |

## Manual checklist (flows 2 to 10 in the UI)

1. Sign up with a fresh email, sign out, sign back in.
2. Open an album, tap a score (it saves immediately), reload: the score is still there.
3. The Community panel shows your score in the count and average. Change the score: the average moves. Remove the rating: the count drops.
4. Tap Want to listen on another album, then check Library > Want to listen.
5. Create a profile (private), make it public, create a list, make it public, add two albums.
6. In a private window, open the profile and list URLs signed out.
7. From a second account, follow the first, and check Following shows the rating and list.
8. Try the keyboard: Tab to the score buttons, arrows to move, Enter to rate.
