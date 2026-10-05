-- ==============================================================================
-- SUPABASE MIGRATION: Schema do Organizador de Lista de Compras por Setores
-- Data: 2026-10-05
-- Descrição: Criação das tabelas de listas, itens por setor, índices, RLS e triggers.
-- ==============================================================================

-- 1. Habilita extensão para geração de UUID caso não esteja habilitada
create extension if not exists "pgcrypto";

-- 2. Tabela de Listas de Compras
create table if not exists public.shopping_lists (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  title text not null default 'Minha Lista de Supermercado',
  raw_input text not null,
  active_sectors integer default 0 not null,
  total_items integer default 0 not null,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null,
  updated_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- Comentários da tabela
comment on table public.shopping_lists is 'Armazena as listas de compras desestruturadas e seus metadados de setorização.';

-- 3. Tabela de Itens da Lista de Compras
create table if not exists public.shopping_items (
  id uuid primary key default gen_random_uuid(),
  list_id uuid not null references public.shopping_lists(id) on delete cascade,
  raw_text text not null,
  category text not null check (
    category in (
      'hortifruti',
      'acougue_frios',
      'laticinios_padaria',
      'mercearia_despensa',
      'bebidas',
      'limpeza_higiene',
      'outros'
    )
  ),
  completed boolean not null default false,
  position integer not null default 0,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null,
  updated_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- Comentários da tabela
comment on table public.shopping_items is 'Itens individuais categorizados por setores de supermercado com status de coleta.';

-- 4. Índices para Otimização de Performance
create index if not exists idx_shopping_items_list_id on public.shopping_items (list_id);
create index if not exists idx_shopping_items_category on public.shopping_items (category);
create index if not exists idx_shopping_items_completed on public.shopping_items (completed);
create index if not exists idx_shopping_lists_user_id on public.shopping_lists (user_id);
create index if not exists idx_shopping_lists_created_at on public.shopping_lists (created_at desc);

-- 5. Função e Triggers para Atualização Automática de updated_at
create or replace function public.handle_updated_at()
returns trigger as $$
begin
  new.updated_at = timezone('utc'::text, now());
  return new;
end;
$$ language plpgsql security definer;

-- Trigger para shopping_lists
drop trigger if exists set_shopping_lists_updated_at on public.shopping_lists;
create trigger set_shopping_lists_updated_at
  before update on public.shopping_lists
  for each row execute function public.handle_updated_at();

-- Trigger para shopping_items
drop trigger if exists set_shopping_items_updated_at on public.shopping_items;
create trigger set_shopping_items_updated_at
  before update on public.shopping_items
  for each row execute function public.handle_updated_at();

-- 6. Habilitar Segurança por Linha (Row Level Security - RLS)
alter table public.shopping_lists enable row level security;
alter table public.shopping_items enable row level security;

-- Políticas de RLS para shopping_lists
-- Permite leitura e escrita para usuários autenticados em suas próprias listas
create policy "Usuários podem ver suas próprias listas"
  on public.shopping_lists for select
  using (auth.uid() = user_id or user_id is null);

create policy "Usuários podem criar suas próprias listas"
  on public.shopping_lists for insert
  with check (auth.uid() = user_id or user_id is null);

create policy "Usuários podem atualizar suas próprias listas"
  on public.shopping_lists for update
  using (auth.uid() = user_id or user_id is null)
  with check (auth.uid() = user_id or user_id is null);

create policy "Usuários podem excluir suas próprias listas"
  on public.shopping_lists for delete
  using (auth.uid() = user_id or user_id is null);

-- Políticas de RLS para shopping_items
create policy "Usuários podem ver itens das suas listas"
  on public.shopping_items for select
  using (
    exists (
      select 1 from public.shopping_lists l
      where l.id = shopping_items.list_id
      and (l.user_id = auth.uid() or l.user_id is null)
    )
  );

create policy "Usuários podem inserir itens nas suas listas"
  on public.shopping_items for insert
  with check (
    exists (
      select 1 from public.shopping_lists l
      where l.id = shopping_items.list_id
      and (l.user_id = auth.uid() or l.user_id is null)
    )
  );

create policy "Usuários podem atualizar itens das suas listas"
  on public.shopping_items for update
  using (
    exists (
      select 1 from public.shopping_lists l
      where l.id = shopping_items.list_id
      and (l.user_id = auth.uid() or l.user_id is null)
    )
  );

create policy "Usuários podem excluir itens das suas listas"
  on public.shopping_items for delete
  using (
    exists (
      select 1 from public.shopping_lists l
      where l.id = shopping_items.list_id
      and (l.user_id = auth.uid() or l.user_id is null)
    )
  );
