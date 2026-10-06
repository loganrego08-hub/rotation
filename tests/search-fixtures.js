/* Hand-written candidates in the shape of MusicBrainz release-group search results (see RotationLib.candidateOf).
   Numbers for `releases` (editions in the group) and `tags` (genre votes) are modeled on real responses: a famous album has
   dozens of editions and tag votes, an auto-generated single has one edition and none. This is a fixed snapshot, so the tests
   are deterministic. tests/search-regression.html runs the same queries against live MusicBrainz.
   Row: [id, title, artist, artistId, date, primary type, secondary types, releases, tags] */
(function (root) {
  const rows = [
    // "Stick Season": the real album, its singles, an artist-less namesake, and the noise the old search showed
    ["ns-album", "Stick Season", "Noah Kahan", "a-noah", "2022-10-14", "Album", [], 14, 12],
    ["ns-single", "Stick Season", "Noah Kahan", "a-noah", "2022-07-08", "Single", [], 1, 0],
    ["ns-deluxe", "Stick Season (We'll All Be Here Forever)", "Noah Kahan", "a-noah", "2023-06-02", "Album", [], 3, 4],
    ["ns-dupe", "Stick Season (Deluxe Edition)", "Noah Kahan", "a-noah", "2023-01-10", "Album", [], 1, 0],
    ["ss-knuckle", "Stick Season", "Knuckle Puck", "a-knuckle", "2024-07-10", "Single", [], 1, 0],
    ["ss-madilyn", "Stick Season", "Madilyn", "a-madilyn", "2024-02-23", "Single", [], 1, 0],
    ["ss-band", "Stick Season", "Stick Season", "a-ssband", "2021-03-01", "Album", [], 1, 0],
    ["ss-piano", "Stick Season (Piano Tribute)", "Piano Tribute Players", "a-ptp", "2023-03-03", "Album", [], 1, 0],
    ["ss-insect", "Stick Insect", "Gnarly Beast", "a-gb", "2010-05-05", "Album", [], 1, 0],
    ["ss-men", "Stick Men", "Stick Men", "a-sm", "2011-01-01", "Album", [], 2, 2],
    ["ss-figures", "Stick Figures", "Some Duo", "a-sd", "2015-09-09", "Album", [], 1, 0],
    ["ss-tv", "Stick: Season 1 (Apple TV+ soundtrack)", "Various Artists", "a-va", "2023-06-02", "Album", ["Soundtrack"], 1, 0],
    // Kendrick Lamar
    ["kl-gnx", "GNX", "Kendrick Lamar", "a-kl", "2024-11-22", "Album", [], 24, 17],
    ["kl-gkmc", "good kid, m.A.A.d city", "Kendrick Lamar", "a-kl", "2012-10-22", "Album", [], 30, 40],
    ["kl-tpab", "To Pimp a Butterfly", "Kendrick Lamar", "a-kl", "2015-03-15", "Album", [], 32, 44],
    ["gnx-obscure", "GNX", "Dj Obscuro", "a-dj", "2019-04-04", "Single", [], 1, 0],
    ["gnx-trib", "GNX (Tribute Version)", "Cover Kings", "a-ck", "2025-01-01", "Album", [], 1, 0],
    // Beyoncé
    ["by-album", "BEYONCÉ", "Beyoncé", "a-by", "2013-12-13", "Album", [], 28, 14],
    ["by-single", "BEYONCÉ", "Beyoncé", "a-by", "2013-12-20", "Single", [], 2, 2],
    ["by-lemonade", "Lemonade", "Beyoncé", "a-by", "2016-04-23", "Album", [], 35, 30],
    ["by-live", "The Beyoncé Experience Live", "Beyoncé", "a-by", "2007-11-16", "Album", ["Live"], 2, 2],
    ["by-best", "The Official Best of Beyoncé", "Beyoncé", "a-by", "2006", "Other", ["Compilation"], 1, 0],
    ["by-karaoke", "Beyoncé Karaoke Hits", "Karaoke Stars", "a-ks", "2014-02-02", "Album", [], 1, 0],
    // The Weeknd
    ["tw-ah", "After Hours", "The Weeknd", "a-tw", "2020-03-20", "Album", [], 30, 25],
    ["tw-starboy", "Starboy", "The Weeknd", "a-tw", "2016-11-25", "Album", [], 28, 22],
    ["tw-dawn", "Dawn FM", "The Weeknd", "a-tw", "2022-01-07", "Album", [], 14, 10],
    ["tw-piano", "The Weeknd Piano Tribute", "Piano Covers", "a-pc", "2021-01-01", "Album", [], 1, 0],
    ["tw-weeknd", "Weeknd", "Some Band", "a-sb", "2015-06-06", "Single", [], 1, 0],
    // Pink Floyd
    ["pf-dsotm", "The Dark Side of the Moon", "Pink Floyd", "a-pf", "1973-03-01", "Album", [], 90, 80],
    ["ds-obscure", "Dark Side", "Nobody Special", "a-ns", "2018-08-08", "Single", [], 1, 0],
    ["ds-piano", "Dark Side of the Moon (Piano Tribute)", "Piano Covers", "a-pc", "2019-01-01", "Album", [], 1, 0],
    // Taylor Swift
    ["ts-debut", "Taylor Swift", "Taylor Swift", "a-ts", "2006-10-24", "Album", [], 57, 37],
    ["ts-1989", "1989", "Taylor Swift", "a-ts", "2014-10-27", "Album", [], 40, 30],
    ["ts-folklore", "folklore", "Taylor Swift", "a-ts", "2020-07-24", "Album", [], 25, 20],
    ["ts-karaoke", "Taylor Swift Karaoke: Taylor Swift", "Taylor Swift", "a-ts", "2009-01-27", "Album", ["Remix"], 10, 6],
    ["ts-mega", "The Taylor Swift Megamix", "Taylor Swift", "a-ts", "2015", "Album", ["DJ-mix"], 1, 1],
    // "midnights": one real album, then exact-title records nobody has heard of and cover records
    ["mn-ts", "Midnights", "Taylor Swift", "a-ts", "2022-10-21", "Album", [], 40, 30],
    ["mn-peace", "Midnights", "Peaceful Noise", "a-pn", "2020-05-05", "Album", [], 1, 0],
    ["mn-beautiful", "beautiful midnights", "undersaken", "a-un", "2019-02-02", "Album", [], 1, 0],
    ["mn-violin", "Midnights (The Violin Covers)", "Ana Done", "a-ad", "2023-01-01", "Album", [], 1, 0],
    ["mn-lofi", "midnights (3am lofi hip hop study edition)", "lonelyboy", "a-lb", "2023-02-02", "Album", [], 2, 1],
    ["mn-armstrong", "Midnights at V-Disc", "Louis Armstrong", "a-la", "1996", "Album", [], 3, 3],
    // Mac Miller
    ["mm-swim", "Swimming", "Mac Miller", "a-mm", "2018-08-03", "Album", [], 20, 15],
    ["mm-circles", "Circles", "Mac Miller", "a-mm", "2020-01-17", "Album", [], 16, 12],
    ["sw-other", "Swimming", "Some Band", "a-sob", "2012-05-05", "Album", [], 2, 1],
    ["sw-pool", "Swimming Pool", "Drifters Cove", "a-dc", "2016-06-06", "Album", [], 1, 0],
  ];
  root.SEARCH_FIXTURE = rows.map(([id, title, artist, artistId, date, type, secondary, releases, tags]) => ({ id, title, artist, artistId, date, type, secondary, releases, tags }));
})(typeof window !== "undefined" ? window : globalThis);
