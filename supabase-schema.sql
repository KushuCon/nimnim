-- Run this in Supabase SQL Editor once.

create extension if not exists pgcrypto;
create extension if not exists vector;

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  username text not null unique,
  password_hash text not null,
  created_at timestamptz not null default now()
);

create table if not exists sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists sessions_user_idx on sessions(user_id);
create index if not exists sessions_expires_idx on sessions(expires_at);

create table if not exists conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  title text not null default 'New Chat',
  tags text[] not null default '{}'::text[],
  total_tokens_est bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists conversations_user_idx on conversations(user_id);
create index if not exists conversations_updated_idx on conversations(updated_at desc);
alter table conversations
  add column if not exists tags text[] not null default '{}'::text[];

alter table conversations
  add column if not exists total_tokens_est bigint not null default 0;

create table if not exists messages (
  id bigint generated always as identity primary key,
  conversation_id uuid not null references conversations(id) on delete cascade,
  role text not null check (role in ('user','assistant','system')),
  content text not null,
  model_id text,
  created_at timestamptz not null default now()
);

create index if not exists messages_conversation_idx on messages(conversation_id, id);
create index if not exists idx_messages_conv_created on messages(conversation_id, created_at desc);

create table if not exists global_stats (
  id int primary key default 1,
  total_calls bigint not null default 0,
  tavily_calls bigint not null default 0,
  model_counts jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  constraint global_stats_singleton check (id = 1)
);

alter table global_stats
add column if not exists tavily_calls bigint not null default 0;

insert into global_stats (id) values (1)
on conflict (id) do nothing;

create or replace function increment_global_call(match_model_id text)
returns table (
  total_calls bigint,
  model_counts jsonb,
  updated_at timestamptz
)
language sql
security definer
set search_path = public
as $$
  insert into global_stats (id) values (1)
  on conflict (id) do nothing;

  update global_stats
  set
    total_calls = global_stats.total_calls + 1,
    model_counts = jsonb_set(
      global_stats.model_counts,
      array[match_model_id],
      to_jsonb(coalesce((global_stats.model_counts ->> match_model_id)::bigint, 0) + 1),
      true
    ),
    updated_at = now()
  where id = 1
  returning global_stats.total_calls, global_stats.model_counts, global_stats.updated_at;
$$;

create or replace function increment_tavily_call()
returns table (
  total_calls bigint,
  tavily_calls bigint,
  model_counts jsonb,
  updated_at timestamptz
)
language sql
security definer
set search_path = public
as $$
  insert into global_stats (id) values (1)
  on conflict (id) do nothing;

  update global_stats
  set
    tavily_calls = global_stats.tavily_calls + 1,
    updated_at = now()
  where id = 1
  returning global_stats.total_calls, global_stats.tavily_calls, global_stats.model_counts, global_stats.updated_at;
$$;

create table if not exists memory_chunks (
  id bigint generated always as identity primary key,
  user_id uuid not null references users(id) on delete cascade,
  conversation_id uuid not null references conversations(id) on delete cascade,
  message_id bigint not null references messages(id) on delete cascade,
  role text not null check (role in ('user','assistant','system')),
  chunk_text text not null,
  embedding vector,
  created_at timestamptz not null default now()
);

create index if not exists memory_chunks_user_idx on memory_chunks(user_id);
create index if not exists memory_chunks_conversation_idx on memory_chunks(conversation_id);
create index if not exists memory_chunks_message_idx on memory_chunks(message_id);
create index if not exists idx_memory_chunks_user_conv on memory_chunks(user_id, conversation_id);

create table if not exists pinned_messages (
  id bigserial primary key,
  user_id uuid not null references users(id) on delete cascade,
  message_id bigint not null references messages(id) on delete cascade,
  conversation_id uuid not null references conversations(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (user_id, message_id)
);

create index if not exists pinned_messages_user_idx on pinned_messages(user_id);
create index if not exists pinned_messages_conversation_idx on pinned_messages(conversation_id);
create index if not exists pinned_messages_message_idx on pinned_messages(message_id);

create table if not exists message_feedback (
  id bigserial primary key,
  user_id uuid not null references users(id) on delete cascade,
  message_id bigint not null references messages(id) on delete cascade,
  conversation_id uuid not null references conversations(id) on delete cascade,
  feedback text not null check (feedback in ('up','down')),
  created_at timestamptz not null default now(),
  unique (user_id, message_id)
);

create index if not exists message_feedback_user_idx on message_feedback(user_id);
create index if not exists message_feedback_conversation_idx on message_feedback(conversation_id);
create index if not exists message_feedback_message_idx on message_feedback(message_id);

create table if not exists rag_blacklist (
  id bigserial primary key,
  user_id uuid references users(id) on delete cascade,
  conversation_id uuid references conversations(id) on delete cascade,
  reason text,
  created_at timestamptz default now(),
  unique (user_id, conversation_id)
);

create index if not exists rag_blacklist_user_idx on rag_blacklist(user_id);
create index if not exists rag_blacklist_conversation_idx on rag_blacklist(conversation_id);

create table if not exists memory_summaries (
  id bigint generated always as identity primary key,
  user_id uuid not null references users(id) on delete cascade,
  conversation_id uuid not null references conversations(id) on delete cascade,
  upto_message_id bigint not null,
  summary_text text not null,
  embedding vector,
  created_at timestamptz not null default now()
);

create index if not exists memory_summaries_user_idx on memory_summaries(user_id);
create index if not exists memory_summaries_conversation_idx on memory_summaries(conversation_id);
create index if not exists memory_summaries_upto_idx on memory_summaries(upto_message_id);

do $$
declare
  v_dim int;
  v_distinct_dims int;
begin
  -- HNSW needs a fixed-dimension vector column (vector(N)).
  select count(distinct vector_dims(embedding))
    into v_distinct_dims
  from memory_chunks
  where embedding is not null;

  if v_distinct_dims = 0 then
    raise notice 'Skipping HNSW: memory_chunks.embedding has no data yet. Re-run this block after first indexed messages.';
    return;
  end if;

  if v_distinct_dims > 1 then
    raise exception 'Cannot enable HNSW: memory_chunks.embedding contains mixed dimensions. Clean data to a single dimension first.';
  end if;

  select vector_dims(embedding)
    into v_dim
  from memory_chunks
  where embedding is not null
  limit 1;

  execute format(
    'alter table memory_chunks alter column embedding type vector(%s) using embedding::vector(%s)',
    v_dim,
    v_dim
  );

  -- Keep summary embeddings compatible with the same vector dimension when present.
  begin
    execute format(
      'alter table memory_summaries alter column embedding type vector(%s) using case when embedding is null then null else embedding::vector(%s) end',
      v_dim,
      v_dim
    );
  exception
    when others then
      raise notice 'memory_summaries.embedding dimension update skipped: %', sqlerrm;
  end;

  execute 'drop index if exists memory_chunks_embedding_idx';
  execute 'create index if not exists memory_chunks_embedding_idx on memory_chunks using hnsw (embedding vector_cosine_ops) with (m = 16, ef_construction = 64)';

  raise notice 'HNSW enabled on memory_chunks.embedding with dimension %', v_dim;
end $$;

create or replace function match_memory_chunks(
  query_embedding vector,
  match_user_id uuid,
  match_conversation_ids uuid[] default null,
  match_count int default 8
)
returns table (
  id bigint,
  message_id bigint,
  conversation_id uuid,
  role text,
  chunk_text text,
  created_at timestamptz,
  similarity float
)
language sql
stable
set search_path = public
as $$
  select
    mc.id,
    mc.message_id,
    mc.conversation_id,
    mc.role,
    mc.chunk_text,
    mc.created_at,
    (mc.embedding <=> query_embedding) as similarity
  from memory_chunks mc
  where mc.user_id = match_user_id
    and mc.embedding is not null
    and (match_conversation_ids is null or mc.conversation_id = any(match_conversation_ids))
  order by mc.embedding <=> query_embedding
  limit greatest(1, least(match_count, 40));
$$;
