create table if not exists public.quiz_attempts (
  device_id uuid primary key,
  player_name text not null check (char_length(player_name) between 1 and 20),
  status text not null default 'started' check (status in ('started', 'finished')),
  started_at timestamptz not null default clock_timestamp(),
  submitted_score integer check (submitted_score between 0 and 100 and submitted_score % 10 = 0),
  submitted_time_taken integer check (submitted_time_taken between 0 and 86400)
);

create table if not exists public.quiz_scores (
  device_id uuid primary key references public.quiz_attempts(device_id),
  player_name text not null check (char_length(player_name) between 1 and 20),
  score integer not null check (score between 0 and 100 and score % 10 = 0),
  time_taken integer not null check (time_taken between 0 and 86400),
  created_at timestamptz not null default clock_timestamp()
);

alter table public.quiz_attempts enable row level security;
alter table public.quiz_scores enable row level security;

revoke all on public.quiz_attempts from anon, authenticated;
revoke all on public.quiz_scores from anon, authenticated;

create or replace function public.get_quiz_leaderboard(p_device_id uuid)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'leaderboard',
    coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'name', ranked.player_name,
          'score', ranked.score,
          'timeTaken', ranked.time_taken,
          'timestamp', ranked.created_at
        )
        order by ranked.score desc, ranked.time_taken asc, ranked.created_at asc, ranked.player_name asc
      )
      from (
        select player_name, score, time_taken, created_at
        from public.quiz_scores
        order by score desc, time_taken asc, created_at asc, player_name asc
        limit 10
      ) ranked
    ), '[]'::jsonb),
    'hasUsedAttempt',
    exists(select 1 from public.quiz_attempts where device_id = p_device_id),
    'attemptStatus',
    (select status from public.quiz_attempts where device_id = p_device_id)
  );
$$;

create or replace function public.start_quiz_attempt(p_device_id uuid, p_name text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_name is null or char_length(btrim(p_name)) not between 1 and 20 then
    return jsonb_build_object('error', 'invalid_name');
  end if;

  insert into public.quiz_attempts (device_id, player_name)
  values (p_device_id, btrim(p_name))
  on conflict (device_id) do nothing;

  if not found then
    return jsonb_build_object('error', 'already_played');
  end if;

  return jsonb_build_object('name', btrim(p_name));
end;
$$;

create or replace function public.finish_quiz_attempt(
  p_device_id uuid,
  p_name text,
  p_score integer,
  p_time_taken integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  attempt public.quiz_attempts%rowtype;
  measured_time integer;
  leaderboard jsonb;
begin
  if p_name is null
    or char_length(btrim(p_name)) not between 1 and 20
    or p_score is null
    or p_score not between 0 and 100
    or p_score % 10 <> 0
    or p_time_taken is null
    or p_time_taken not between 0 and 86400 then
    return jsonb_build_object('error', 'invalid_submission');
  end if;

  select *
  into attempt
  from public.quiz_attempts
  where device_id = p_device_id
  for update;

  if not found then
    return jsonb_build_object('error', 'not_started');
  end if;

  if attempt.player_name <> btrim(p_name) then
    return jsonb_build_object('error', 'name_mismatch');
  end if;

  if attempt.status = 'finished' then
    if attempt.submitted_score <> p_score or attempt.submitted_time_taken <> p_time_taken then
      return jsonb_build_object('error', 'already_finished');
    end if;
  else
    measured_time := greatest(
      p_time_taken,
      floor(extract(epoch from (clock_timestamp() - attempt.started_at))::numeric)::integer
    );

    insert into public.quiz_scores (device_id, player_name, score, time_taken)
    values (p_device_id, attempt.player_name, p_score, measured_time);

    update public.quiz_attempts
    set status = 'finished',
        submitted_score = p_score,
        submitted_time_taken = p_time_taken
    where device_id = p_device_id;
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'name', ranked.player_name,
        'score', ranked.score,
        'timeTaken', ranked.time_taken,
        'timestamp', ranked.created_at
      )
      order by ranked.score desc, ranked.time_taken asc, ranked.created_at asc, ranked.player_name asc
    ),
    '[]'::jsonb
  )
  into leaderboard
  from (
    select player_name, score, time_taken, created_at
    from public.quiz_scores
    order by score desc, time_taken asc, created_at asc, player_name asc
    limit 10
  ) ranked;

  return jsonb_build_object('leaderboard', leaderboard);
end;
$$;

revoke all on function public.get_quiz_leaderboard(uuid) from public, anon, authenticated;
revoke all on function public.start_quiz_attempt(uuid, text) from public, anon, authenticated;
revoke all on function public.finish_quiz_attempt(uuid, text, integer, integer) from public, anon, authenticated;
grant execute on function public.get_quiz_leaderboard(uuid) to service_role;
grant execute on function public.start_quiz_attempt(uuid, text) to service_role;
grant execute on function public.finish_quiz_attempt(uuid, text, integer, integer) to service_role;
