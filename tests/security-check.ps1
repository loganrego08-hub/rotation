# Checks, over the public REST API with only the publishable (anon) key, that a signed-out visitor
# can read only what is meant to be public and cannot write anything. Read-only except for write attempts that must fail.
#   powershell -File tests/security-check.ps1
$cfg = Get-Content (Join-Path $PSScriptRoot "..\config.js") -Raw
$url = [regex]::Match($cfg, 'SUPABASE_URL:\s*"([^"]+)"').Groups[1].Value
$key = [regex]::Match($cfg, 'SUPABASE_ANON_KEY:\s*"([^"]+)"').Groups[1].Value
$h = @{ apikey = $key; "Content-Type" = "application/json" }
$fail = 0
function Check($name, $okCondition, $detail) { if ($okCondition) { "PASS  $name" } else { "FAIL  $name  $detail"; $script:fail++ } }
function Get-Rows($t) { try { ,@(Invoke-RestMethod -Headers $h "$url/rest/v1/${t}?select=*&limit=5") } catch { $null } }

# Tables that must be private: anon sees zero rows (RLS) or is refused outright
foreach ($t in "ratings", "album_status", "profiles", "profile_pins", "follows", "lists", "list_items", "review_likes", "reports", "notifications", "notification_prefs") {
  $r = Get-Rows $t
  Check "anon cannot read private table $t" ($null -eq $r -or @($r[0]).Count -eq 0) "got rows"
}
# Public views must be readable (and must not expose user ids or emails)
foreach ($v in "album_stats", "album_rankings", "album_catalog", "album_reviews", "public_profiles", "public_ratings", "public_lists", "public_list_items", "public_pins", "public_reviews") {
  $r = Get-Rows $v
  Check "public view $v is readable" ($null -ne $r) "request failed"
  if ($r -and @($r[0]).Count -gt 0) { $cols = ($r[0][0] | Get-Member -MemberType NoteProperty).Name; Check "view $v exposes no user_id or email" (-not ($cols -contains "user_id" -or $cols -contains "email")) ($cols -join ",") }
}
# Writes must be refused
foreach ($w in @(@("ratings", '{"album_id":"x","score":5}'), @("albums", '{"id":"bbbbbbbb-0000-4000-8000-000000000009","title":"t","artist":"a"}'), @("lists", '{"title":"x"}'), @("profiles", '{"username":"anon_user"}'), @("reports", '{"target_type":"review","target_id":"x","reason":"spam"}'))) {
  $code = 0; try { Invoke-WebRequest -UseBasicParsing -Method Post -Headers $h "$url/rest/v1/$($w[0])" -Body $w[1] | Out-Null; $code = 200 } catch { $code = [int]$_.Exception.Response.StatusCode }
  Check "anon cannot insert into $($w[0])" ($code -in 401, 403) "status $code"
}
# Functions that need a signed-in user must refuse anon
foreach ($f in "follow_user", "toggle_review_like", "report_content", "get_feed", "mark_notifications_read", "recs_from_similar_listeners") {
  $code = 0; try { Invoke-WebRequest -UseBasicParsing -Method Post -Headers $h "$url/rest/v1/rpc/$f" -Body "{}" | Out-Null; $code = 200 } catch { $code = [int]$_.Exception.Response.StatusCode }
  Check "anon cannot call $f" ($code -in 401, 403, 404) "status $code"
}
""
if ($fail) { "$fail check(s) FAILED"; exit 1 } else { "All checks passed" }
