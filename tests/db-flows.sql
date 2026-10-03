-- Rotation database flow tests. Run in the Supabase SQL editor (or through any SQL runner).
-- Everything happens inside one transaction that always rolls back: the final RAISE EXCEPTION carries the results,
-- so no data is created, changed or left behind. Requires at least two existing users in auth.users.
--
-- These exercise the database rules end to end as the "authenticated" role (so row-level security really applies):
--   rating, persistence, duplicate prevention, aggregates, edit/remove, listening status, public lists seen by another user,
--   following and the activity feed, and that one user cannot modify another user's data.
-- They do NOT exercise the browser UI. Sign-up, sign-in and clicking through screens still need a manual pass.
do $$
declare
  u1 uuid; u2 uuid; n1 text; a1 text := 'bbbbbbbb-0000-4000-8000-000000000001'; a2 text := 'bbbbbbbb-0000-4000-8000-000000000002';
  r text := ''; n int; v numeric; lid uuid; rid uuid; ok boolean;
  procedure_note text;
  function_dummy int;
begin
  alter table public.ratings disable trigger ratings_guard;
  select id into u1 from auth.users order by created_at limit 1;
  select id into u2 from auth.users where id <> u1 order by created_at limit 1;
  if u2 is null then raise exception 'NEED_TWO_USERS'; end if;
  insert into public.albums (id, title, artist, tracks, genres) values (a1, 'Flow Test One', 'Flow Artist', '[]'::jsonb, '{rock}'), (a2, 'Flow Test Two', 'Flow Artist', '[]'::jsonb, '{rock}');
  insert into public.profiles (user_id, username, is_public, show_ratings) values (u1, 'flow_one', true, true), (u2, 'flow_two', true, true)
    on conflict (user_id) do update set is_public = true, show_ratings = true;
  select username into n1 from public.profiles where user_id = u1;

  -- ===== as user 1 =====
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', u1, 'role', 'authenticated')::text, true);
  insert into public.ratings (user_id, album_id, score) values (u1, a1, 8) returning id into rid;
  r := r || 'rated; ';
  select count(*) into n from public.ratings where user_id = u1 and album_id = a1; r := r || format('[persist] rows after reread=%s; ', n);
  select (listened and not want) into ok from public.album_status where user_id = u1 and album_id = a1; r := r || format('[status] rating implies listened=%s; ', ok);
  begin insert into public.ratings (user_id, album_id, score) values (u1, a1, 5); r := r || '[duplicate] ALLOWED (bad); '; exception when unique_violation then r := r || '[duplicate] blocked; '; end;
  begin insert into public.ratings (user_id, album_id, score) values (u1, a2, 11); r := r || '[score range] ALLOWED (bad); '; exception when check_violation then r := r || '[score range] blocked; '; end;
  insert into public.album_status (album_id, want) values (a2, true); select want into ok from public.album_status where user_id = u1 and album_id = a2; r := r || format('[save to library] want=%s; ', ok);
  insert into public.lists (title, is_public) values ('Flow public list', true) returning id into lid;
  insert into public.list_items (list_id, album_id) values (lid, a1), (lid, a2);
  insert into public.lists (title, is_public) values ('Flow private list', false);
  reset role;

  -- ===== aggregates (view runs as owner) =====
  select rating_count, avg_score into n, v from public.album_stats where album_id = a1; r := r || format('[aggregate] after 1 rating count=%s avg=%s; ', n, v);

  -- ===== as user 2 =====
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', u2, 'role', 'authenticated')::text, true);
  insert into public.ratings (user_id, album_id, score) values (u2, a1, 4);
  reset role;
  select rating_count, avg_score into n, v from public.album_stats where album_id = a1; r := r || format('[aggregate] after 2nd user count=%s avg=%s; ', n, v);

  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', u2, 'role', 'authenticated')::text, true);
  select count(*) into n from public.public_lists where id = lid; r := r || format('[other user sees public list]=%s; ', n);
  select count(*) into n from public.public_list_items where list_id = lid; r := r || format('[...with its items]=%s; ', n);
  select count(*) into n from public.public_lists where title = 'Flow private list'; r := r || format('[other user sees private list]=%s; ', n);
  perform public.follow_user(n1);
  select count(*) into n from public.get_feed(null, null, 50) where actor_username = n1 and album_id = a1; r := r || format('[feed shows followed user''s rating]=%s; ', n);
  select count(*) into n from public.get_feed(null, null, 50) where list_id = lid; r := r || format('[feed shows their new public list]=%s; ', n);

  -- ===== authorization: user 2 against user 1's data =====
  update public.ratings set score = 1 where id = rid; get diagnostics n = row_count; r := r || format('[unauthorized] update other''s rating rows=%s; ', n);
  delete from public.ratings where id = rid; get diagnostics n = row_count; r := r || format('[unauthorized] delete other''s rating rows=%s; ', n);
  begin insert into public.ratings (user_id, album_id, score) values (u1, a2, 9); r := r || '[unauthorized] insert rating as someone else ALLOWED (bad); '; exception when others then r := r || '[unauthorized] insert as someone else blocked; '; end;
  update public.lists set title = 'hijacked' where id = lid; get diagnostics n = row_count; r := r || format('[unauthorized] edit other''s list rows=%s; ', n);
  begin insert into public.list_items (list_id, album_id) values (lid, a2) ; r := r || '[unauthorized] add to other''s list ALLOWED (bad); '; exception when others then r := r || '[unauthorized] add to other''s list blocked; '; end;
  select count(*) into n from public.album_status where user_id = u1; r := r || format('[unauthorized] read other''s listening status rows=%s; ', n);
  select count(*) into n from public.profile_pins where user_id = u1; r := r || format('[unauthorized] read other''s pins rows=%s; ', n);
  update public.albums set title = 'HACKED' where id = a1; get diagnostics n = row_count;
  reset role;
  select title into procedure_note from public.albums where id = a1; r := r || format('[album facts] title after attempted overwrite=%s; ', procedure_note);

  -- ===== as anon =====
  set local role anon;
  begin insert into public.ratings (user_id, album_id, score) values (u1, a2, 9); r := r || '[anon] insert ALLOWED (bad); '; exception when others then r := r || '[anon] insert blocked; '; end;
  select count(*) into n from public.ratings; r := r || format('[anon] ratings readable=%s; ', n);
  select count(*) into n from public.public_lists where id = lid; r := r || format('[anon] public list visible=%s; ', n);
  reset role;

  -- ===== edit and remove (user 1), then aggregates again =====
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', u1, 'role', 'authenticated')::text, true);
  update public.ratings set score = 10 where id = rid; get diagnostics n = row_count; r := r || format('[edit own] rows=%s; ', n);
  reset role;
  select rating_count, avg_score into n, v from public.album_stats where album_id = a1; r := r || format('[aggregate] after edit count=%s avg=%s; ', n, v);
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', u1, 'role', 'authenticated')::text, true);
  delete from public.ratings where id = rid; get diagnostics n = row_count; r := r || format('[remove own] rows=%s; ', n);
  reset role;
  select coalesce(max(rating_count), 0), max(avg_score) into n, v from public.album_stats where album_id = a1; r := r || format('[aggregate] after remove count=%s avg=%s; ', n, v);
  select (listened) into ok from public.album_status where user_id = u1 and album_id = a1; r := r || format('[status] still listened after removing rating=%s; ', ok);

  raise exception 'ROLLBACK_OK %', r;
end $$;
