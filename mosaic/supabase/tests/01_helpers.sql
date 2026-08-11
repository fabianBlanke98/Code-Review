-- Tiny assertion helpers. SECURITY INVOKER on purpose: assertions must run with
-- the permissions of whichever role the test has switched to, otherwise they
-- would not exercise RLS at all.

create schema if not exists tests;

create or replace function tests.as_user(p_uid uuid)
returns void
language plpgsql
as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_uid)::text, false);
end
$$;

create or replace function tests.anonymous()
returns void
language plpgsql
as $$
begin
  perform set_config('request.jwt.claims', '', false);
end
$$;

create or replace function tests.eq(p_label text, p_actual text, p_expected text)
returns void
language plpgsql
as $$
begin
  if p_actual is distinct from p_expected then
    raise exception 'FAIL: % — got "%", want "%"',
      p_label, coalesce(p_actual, '<null>'), coalesce(p_expected, '<null>');
  end if;
  raise notice 'ok  %', p_label;
end
$$;

create or replace function tests.eq(p_label text, p_actual bigint, p_expected bigint)
returns void
language plpgsql
as $$
begin
  perform tests.eq(p_label, p_actual::text, p_expected::text);
end
$$;

create or replace function tests.is_true(p_label text, p_actual boolean)
returns void
language plpgsql
as $$
begin
  perform tests.eq(p_label, coalesce(p_actual, false)::text, 'true');
end
$$;

-- Asserts that `p_sql` fails and that the error text contains `p_msg`.
create or replace function tests.raises(p_label text, p_sql text, p_msg text)
returns void
language plpgsql
as $$
declare
  v_failed boolean := false;
  v_got    text;
begin
  begin
    execute p_sql;
  exception
    when others then
      v_failed := true;
      v_got := sqlerrm;
  end;

  if not v_failed then
    raise exception 'FAIL: % — expected error containing "%", but the statement succeeded', p_label, p_msg;
  end if;
  if position(p_msg in v_got) = 0 then
    raise exception 'FAIL: % — expected error containing "%", got "%"', p_label, p_msg, v_got;
  end if;
  raise notice 'ok  % (rejected: %)', p_label, p_msg;
end
$$;
