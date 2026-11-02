-- MHM — schéma Supabase. À coller tel quel dans Supabase → SQL Editor → New query → Run.

-- 1) Tables --------------------------------------------------------------------------------
create table if not exists public.posts (
  id         text primary key,
  text       text not null check (char_length(text) between 20 and 1200),
  mood       text not null default 'Autre' check (mood in ('Stress','Solitude','Études','Famille','Espoir','Autre')),
  created_at timestamptz not null default now()
);

create table if not exists public.votes (
  post_id text not null references public.posts(id) on delete cascade,
  voter   text not null,                                   -- identifiant anonyme d'appareil (aucune donnée personnelle)
  v       smallint not null check (v in (1, -1)),
  primary key (post_id, voter)
);

create table if not exists public.comments (
  id         text primary key,
  post_id    text not null references public.posts(id) on delete cascade,
  text       text not null check (char_length(text) between 2 and 300),
  created_at timestamptz not null default now()
);
create index if not exists comments_post_idx on public.comments (post_id, created_at);

create table if not exists public.rate_limits (           -- anti-spam (IP hachée, jamais en clair)
  key text primary key,
  at  timestamptz not null default now()
);

-- 2) Sécurité : RLS activée SANS aucune policy = personne ne peut lire/écrire avec la clé publique.
--    Seul le serveur (clé service_role, variable d'environnement Vercel) accède aux données.
alter table public.posts       enable row level security;
alter table public.votes       enable row level security;
alter table public.comments    enable row level security;
alter table public.rate_limits enable row level security;

-- 3) Fonction qui renvoie tout le fil en une seule requête (histoires + votes + commentaires)
create or replace function public.mhm_feed(p_voter text)
returns json
language sql
security definer
set search_path = public
as $$
  select coalesce(json_agg(row_to_json(t) order by t.ts desc), '[]'::json)
  from (
    select p.id, p.text, p.mood,
           (extract(epoch from p.created_at) * 1000)::bigint as ts,
           (select count(*) from votes v where v.post_id = p.id and v.v = 1)::int  as up,
           (select count(*) from votes v where v.post_id = p.id and v.v = -1)::int as down,
           coalesce((select v.v from votes v where v.post_id = p.id and v.voter = p_voter), 0)::int as my,
           coalesce((select json_agg(json_build_object('id', c.id, 'text', c.text, 'ts', (extract(epoch from c.created_at) * 1000)::bigint) order by c.created_at)
                     from comments c where c.post_id = p.id), '[]'::json) as comments
    from posts p
    order by p.created_at desc
    limit 300
  ) t;
$$;
revoke all on function public.mhm_feed(text) from public, anon, authenticated;
grant execute on function public.mhm_feed(text) to service_role;
