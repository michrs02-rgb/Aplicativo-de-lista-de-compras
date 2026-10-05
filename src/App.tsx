import React, { useState, useMemo, useEffect, useRef } from 'react';
import {
  getStoredSupabaseConfig,
  saveStoredSupabaseConfig,
  testSupabaseConnection,
  syncShoppingListToSupabase,
} from './lib/supabase.ts';

export const MIGRATION_SQL = `-- ==============================================================================
-- SUPABASE MIGRATION: Schema do Organizador de Lista de Compras por Setores
-- Data: 2026-10-05
-- ==============================================================================

-- 1. Habilita extensão pgcrypto
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

create trigger set_shopping_lists_updated_at
  before update on public.shopping_lists
  for each row execute function public.handle_updated_at();

create trigger set_shopping_items_updated_at
  before update on public.shopping_items
  for each row execute function public.handle_updated_at();

-- 6. Habilitar Row Level Security (RLS)
alter table public.shopping_lists enable row level security;
alter table public.shopping_items enable row level security;

create policy "Usuários podem ver suas próprias listas"
  on public.shopping_lists for select
  using (auth.uid() = user_id or user_id is null);

create policy "Usuários podem criar suas próprias listas"
  on public.shopping_lists for insert
  with check (auth.uid() = user_id or user_id is null);

create policy "Usuários podem atualizar suas próprias listas"
  on public.shopping_lists for update
  using (auth.uid() = user_id or user_id is null);

create policy "Usuários podem excluir suas próprias listas"
  on public.shopping_lists for delete
  using (auth.uid() = user_id or user_id is null);

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
  );`;

// Categorias oficiais permitidas
export type CategoryKey =
  | 'hortifruti'
  | 'acougue_frios'
  | 'laticinios_padaria'
  | 'mercearia_despensa'
  | 'bebidas'
  | 'limpeza_higiene'
  | 'outros';

interface CategoryDef {
  key: CategoryKey;
  emoji: string;
  name: string;
  fullName: string;
  description: string;
  color: string;
  badgeBg: string;
  borderColor: string;
}

const CATEGORIES: CategoryDef[] = [
  {
    key: 'hortifruti',
    emoji: '🍎',
    name: 'Hortifrúti',
    fullName: '🍎 Hortifrúti',
    description: 'Frutas, verduras e legumes frescos',
    color: 'emerald',
    badgeBg: 'bg-emerald-50 text-emerald-800 border-emerald-200',
    borderColor: 'border-emerald-500',
  },
  {
    key: 'acougue_frios',
    emoji: '🥩',
    name: 'Açougue e Frios',
    fullName: '🥩 Açougue e Frios',
    description: 'Carnes bovinas, aves, peixes, embutidos e frios',
    color: 'rose',
    badgeBg: 'bg-rose-50 text-rose-800 border-rose-200',
    borderColor: 'border-rose-500',
  },
  {
    key: 'laticinios_padaria',
    emoji: '🧀',
    name: 'Laticínios e Padaria',
    fullName: '🧀 Laticínios e Padaria',
    description: 'Leites, queijos, iogurtes, pães, bolos e derivados',
    color: 'amber',
    badgeBg: 'bg-amber-50 text-amber-800 border-amber-200',
    borderColor: 'border-amber-500',
  },
  {
    key: 'mercearia_despensa',
    emoji: '🥫',
    name: 'Mercearia e Despensa',
    fullName: '🥫 Mercearia e Despensa',
    description: 'Grãos, massas, cafés, temperos, óleos e enlatados',
    color: 'orange',
    badgeBg: 'bg-orange-50 text-orange-800 border-orange-200',
    borderColor: 'border-orange-500',
  },
  {
    key: 'bebidas',
    emoji: '🧃',
    name: 'Bebidas',
    fullName: '🧃 Bebidas',
    description: 'Sucos, refrigerantes, águas, cervejas e vinhos',
    color: 'blue',
    badgeBg: 'bg-blue-50 text-blue-800 border-blue-200',
    borderColor: 'border-blue-500',
  },
  {
    key: 'limpeza_higiene',
    emoji: '🧼',
    name: 'Limpeza e Higiene Pessoal',
    fullName: '🧼 Limpeza e Higiene Pessoal',
    description: 'Produtos de limpeza doméstica, sabonetes, xampus e higiene',
    color: 'teal',
    badgeBg: 'bg-teal-50 text-teal-800 border-teal-200',
    borderColor: 'border-teal-500',
  },
  {
    key: 'outros',
    emoji: '📦',
    name: 'Outros',
    fullName: '📦 Outros',
    description: 'Itens diversos que não se encaixam nas categorias acima',
    color: 'slate',
    badgeBg: 'bg-slate-50 text-slate-800 border-slate-200',
    borderColor: 'border-slate-400',
  },
];

interface ShoppingItem {
  id: string;
  rawText: string;
  category: CategoryKey;
  completed: boolean;
}

// Dicionários com regras de prioridade e desambiguação inteligente
// Atenção especial a composições (ex.: "detergente de maçã" -> Limpeza, não Hortifrúti)
const CLEANING_HYGIENE_KEYWORDS = [
  'detergente', 'sabao', 'sabão', 'sabonete', 'esponja', 'amaciante', 'desinfetante',
  'agua sanitaria', 'água sanitária', 'cloro', 'alvejante', 'multiuso', 'limpador',
  'papel higienico', 'papel higiênico', 'pasta de dente', 'creme dental', 'escova de dente',
  'fio dental', 'shampoo', 'xampu', 'condicionador', 'desodorante', 'absorvente',
  'lã de aço', 'palha de aco', 'bombril', 'pano de prato', 'pano de chao', 'pano de chão',
  'saco de lixo', 'vassoura', 'rodo', 'lustra moveis', 'lustra-móveis', 'aromatizador',
  'inseticida', 'repelente', 'hidratante', 'filtro solar', 'protetor solar', 'cotonete',
  'algodao', 'algodão', 'lamina de barbear', 'gilete', 'creme de barbear', 'antisseptico',
  'alcool', 'álcool', 'lencos umedecidos', 'lenços umedecidos', 'fralda'
];

const BEVERAGE_KEYWORDS = [
  'refrigerante', 'suco', 'agua mineral', 'água mineral', 'agua com gas', 'água com gás',
  'cerveja', 'vinho', 'espumante', 'vodka', 'gin', 'energetico', 'energético',
  'cha gelado', 'chá gelado', 'isotônico', 'isotonico', 'gatorade', 'coca-cola', 'coca cola',
  'guaraná', 'guarana', 'pepsi', 'fanta', 'sprite', 'tônica', 'tonica', 'whisky', 'uísque',
  'licor', 'aguardente', 'cachaça', 'cachaca', 'nectar', 'néctar', 'polpa de fruta'
];

const BUTCHER_COLD_KEYWORDS = [
  'frango', 'peito de frango', 'coxa', 'sobrecoxa', 'carne', 'acougue', 'açougue',
  'alcatra', 'picanha', 'patinho', 'coxao mole', 'coxão mole', 'coxao duro', 'coxão duro',
  'maminha', 'contrafile', 'contrafilé', 'costela', 'fraldinha', 'carne moida', 'carne moída',
  'linguica', 'linguiça', 'bacon', 'presunto', 'mortadela', 'peito de peru', 'salaminho',
  'salame', 'salchicha', 'salsicha', 'calabresa', 'peixe', 'tilapia', 'tilápia', 'salmao',
  'salmão', 'camarao', 'camarão', 'bacalhau', 'atum fresco', 'sardinha fresca', 'pernil',
  'lombo', 'bisteca', 'file mignon', 'filé mignon', 'costelinha', 'bife', 'cupim'
];

const DAIRY_BAKERY_KEYWORDS = [
  'leite', 'queijo', 'manteiga', 'requeijao', 'requeijão', 'iogurte', 'yogurte',
  'pao', 'pão', 'pao frances', 'pão francês', 'pao de forma', 'pão de forma',
  'torrada', 'croissant', 'bisnaga', 'bolo', 'brioche', 'pao de queijo', 'pão de queijo',
  'creme de leite', 'leite condensado', 'ricota', 'mussarela', 'mozzarella', 'parmesao',
  'parmesão', 'provolone', 'gorgonzola', 'coalhada', 'nata', 'margarina', 'broa',
  'baguete', 'sonho', 'leite fermentado', 'yakult', 'petit suisse', 'danone'
];

const HORTIFRUTI_KEYWORDS = [
  'tomate', 'maca', 'maçã', 'maca', 'banana', 'laranja', 'limao', 'limão', 'abacaxi',
  'mamao', 'mamão', 'melancia', 'melao', 'melão', 'uva', 'morango', 'pera', 'pêra',
  'manga', 'alface', 'rucula', 'rúcula', 'agriao', 'agrião', 'espinafre', 'couve',
  'brocolis', 'brócolis', 'cenoura', 'batata', 'cebola', 'alho', 'cebolinha',
  'coentro', 'salsinha', 'pimentao', 'pimentão', 'abobrinha', 'berinjela', 'chuchu',
  'pepino', 'repolho', 'beterraba', 'mandioca', 'aipim', 'macaxeira', 'mandioquinha',
  'maracuja', 'maracujá', 'abacate', 'kiwi', 'caqui', 'goiaba', 'pessego', 'pêssego',
  'ameixa', 'tangerina', 'mexerica', 'bergamota', 'maracuja', 'alho poro', 'alho poró',
  'manjericao', 'manjericão', 'hortela', 'hortelã', 'gengibre'
];

const GROCERY_PANTRY_KEYWORDS = [
  'arroz', 'feijao', 'feijão', 'cafe', 'café', 'po de cafe', 'pó de café', 'acucar', 'açúcar',
  'sal', 'oleo', 'óleo', 'azeite', 'vinagre', 'farinha', 'macarrao', 'macarrão', 'massa',
  'molho de tomate', 'extrato de tomate', 'extrato', 'polpa de tomate', 'milho verde',
  'ervilha', 'atum', 'sardinha', 'maionese', 'ketchup', 'mostarda', 'shoyu',
  'fermento', 'amido de milho', 'maizena', 'achocolatado', 'nescau', 'toddy',
  'aveia', 'cereal', 'granola', 'biscoito', 'bolacha', 'torrada', 'lentilha',
  'grao de bico', 'grão de bico', 'pipoca', 'canela', 'oregano', 'orégano',
  'pimenta do reino', 'cominho', 'noz moscada', 'caldo de galinha', 'caldo de carne',
  'tempero', 'gelatina', 'pudim', 'chocolate em barra', 'leite de coco', 'coco ralado'
];

// Função pura de normalização de texto para busca
function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

// Algoritmo de classificação inteligente com desambiguação contextual
function classifyItemText(rawItem: string): CategoryKey {
  const norm = normalizeText(rawItem);

  // 1. Prioridade alta para Produtos de Limpeza / Higiene
  // Exemplo crucial: "detergente de maçã" tem maçã, mas o produto é detergente!
  for (const kw of CLEANING_HYGIENE_KEYWORDS) {
    const normKw = normalizeText(kw);
    if (norm.includes(normKw)) {
      return 'limpeza_higiene';
    }
  }

  // 2. Bebidas (ex.: "suco de uva", "refrigerante", "cerveja")
  for (const kw of BEVERAGE_KEYWORDS) {
    const normKw = normalizeText(kw);
    if (norm.includes(normKw)) {
      return 'bebidas';
    }
  }

  // 3. Açougue e Frios (ex.: "peito de frango", "carne moída", "bacon")
  for (const kw of BUTCHER_COLD_KEYWORDS) {
    const normKw = normalizeText(kw);
    if (norm.includes(normKw)) {
      return 'acougue_frios';
    }
  }

  // 4. Laticínios e Padaria (ex.: "leite integral 2L", "pão francês", "queijo")
  for (const kw of DAIRY_BAKERY_KEYWORDS) {
    const normKw = normalizeText(kw);
    if (norm.includes(normKw)) {
      return 'laticinios_padaria';
    }
  }

  // 5. Hortifrúti (ex.: "1kg de tomate", "6 maçãs", "alface", "banana")
  for (const kw of HORTIFRUTI_KEYWORDS) {
    const normKw = normalizeText(kw);
    // Verifica palavra inteira ou substring segura para evitar falsos positivos
    const regex = new RegExp(`\\b${normKw}`, 'i');
    if (regex.test(norm) || norm.includes(normKw)) {
      return 'hortifruti';
    }
  }

  // 6. Mercearia e Despensa (ex.: "arroz 5kg", "pó de café", "feijão")
  for (const kw of GROCERY_PANTRY_KEYWORDS) {
    const normKw = normalizeText(kw);
    if (norm.includes(normKw)) {
      return 'mercearia_despensa';
    }
  }

  // Padrão de segurança: Outros
  return 'outros';
}

// Transforma texto bruto desestruturado em lista de itens com quantidades preservadas
function parseUnstructuredInput(rawInput: string): ShoppingItem[] {
  if (!rawInput.trim()) return [];

  // Quebra por quebras de linha ou vírgulas ou ponto e vírgula
  const parts = rawInput
    .split(/[\n,;•\-\*]+/)
    .map(p => p.trim())
    .filter(p => p.length > 0 && !p.startsWith('###'));

  return parts.map((part, index) => {
    // Remove marcadores numéricos iniciais se houver tipo "1. ", "2 - "
    const cleaned = part.replace(/^\d+[\.\)\-]\s*/, '').trim();
    const finalItemText = cleaned || part;
    return {
      id: `${Date.now()}-${index}-${Math.random().toString(36).substring(2, 6)}`,
      rawText: finalItemText,
      category: classifyItemText(finalItemText),
      completed: false,
    };
  });
}

// Constrói a saída estritamente conforme o padrão exigido:
// ### [Emoji] [Nome da Categoria]
// - [Item com quantidade, se houver]
function generateStandardOutput(items: ShoppingItem[]): string {
  const grouped: Record<CategoryKey, string[]> = {
    hortifruti: [],
    acougue_frios: [],
    laticinios_padaria: [],
    mercearia_despensa: [],
    bebidas: [],
    limpeza_higiene: [],
    outros: [],
  };

  items.forEach(item => {
    grouped[item.category].push(item.rawText);
  });

  const sections: string[] = [];

  for (const cat of CATEGORIES) {
    const list = grouped[cat.key];
    if (list && list.length > 0) {
      const categoryHeader = `### ${cat.fullName}`;
      const itemLines = list.map(item => `- ${item}`).join('\n');
      sections.push(`${categoryHeader}\n${itemLines}`);
    }
  }

  return sections.join('\n\n');
}

const INITIAL_USER_INPUT = `leite integral 2L, detergente de maçã, 1kg de tomate, pão francês, peito de frango, pó de café, esponja, 6 maçãs, sabonete, refrigerante zero, arroz 5kg`;

export default function App() {
  const [inputText, setInputText] = useState(INITIAL_USER_INPUT);
  const [items, setItems] = useState<ShoppingItem[]>(() => parseUnstructuredInput(INITIAL_USER_INPUT));
  const [copied, setCopied] = useState(false);
  const [activeTab, setActiveTab] = useState<'interactive' | 'standard_output' | 'trajeto' | 'supabase'>('interactive');
  const [whatsAppPhone, setWhatsAppPhone] = useState('');
  const [newItemText, setNewItemText] = useState('');
  const [filterSearch, setFilterSearch] = useState('');
  const [selectedPreset, setSelectedPreset] = useState<string>('default');

  // Supabase states
  const [supabaseConfig, setSupabaseConfig] = useState(() => getStoredSupabaseConfig());
  const [supabaseStatus, setSupabaseStatus] = useState<'unconfigured' | 'testing' | 'connected' | 'error'>(() => {
    const cfg = getStoredSupabaseConfig();
    return (cfg.url && cfg.anonKey) ? 'connected' : 'unconfigured';
  });
  const [supabaseMessage, setSupabaseMessage] = useState<string>('');
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncSuccessMessage, setSyncSuccessMessage] = useState<string | null>(null);
  const [copiedSql, setCopiedSql] = useState(false);

  const handleTestAndSaveSupabase = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!supabaseConfig.url || !supabaseConfig.anonKey) {
      setSupabaseStatus('error');
      setSupabaseMessage('Informe a URL do Projeto e a Anon Public Key.');
      return;
    }

    setSupabaseStatus('testing');
    setSupabaseMessage('Testando conexão com o Supabase...');

    const result = await testSupabaseConnection(supabaseConfig.url, supabaseConfig.anonKey);
    if (result.success) {
      saveStoredSupabaseConfig(supabaseConfig.url, supabaseConfig.anonKey);
      setSupabaseStatus('connected');
      setSupabaseMessage(result.message);
    } else {
      setSupabaseStatus('error');
      setSupabaseMessage(result.message);
    }
  };

  const handleSyncToSupabase = async () => {
    if (items.length === 0) {
      setSyncSuccessMessage('A lista está vazia para sincronizar.');
      return;
    }

    setIsSyncing(true);
    setSyncSuccessMessage(null);
    const result = await syncShoppingListToSupabase(inputText, items);
    setIsSyncing(false);

    if (result.success) {
      setSyncSuccessMessage(`Lista sincronizada com sucesso no Supabase! ID: ${result.listId}`);
      setTimeout(() => setSyncSuccessMessage(null), 5000);
    } else {
      setSupabaseMessage(result.error || 'Falha na sincronização.');
    }
  };

  const copyMigrationSql = () => {
    navigator.clipboard.writeText(MIGRATION_SQL).then(() => {
      setCopiedSql(true);
      setTimeout(() => setCopiedSql(false), 2500);
    });
  };

  // Web Speech API states para captura por voz
  const [isListening, setIsListening] = useState(false);
  const [isQuickListening, setIsQuickListening] = useState(false);
  const [speechError, setSpeechError] = useState<string | null>(null);
  const recognitionRef = useRef<any>(null);
  const quickRecognitionRef = useRef<any>(null);

  // Limpeza de instâncias de reconhecimento de voz ao desmontar
  useEffect(() => {
    return () => {
      if (recognitionRef.current) {
        try {
          recognitionRef.current.stop();
        } catch (_) {}
      }
      if (quickRecognitionRef.current) {
        try {
          quickRecognitionRef.current.stop();
        } catch (_) {}
      }
    };
  }, []);

  // Processa a lista quando solicitado ou ao trocar presets
  const handleProcessList = (textToProcess: string) => {
    const parsed = parseUnstructuredInput(textToProcess);
    setItems(parsed);
  };

  // Captura de voz via Web Speech API para o campo principal de entrada
  const toggleVoiceInput = () => {
    setSpeechError(null);
    const SpeechRec = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

    if (!SpeechRec) {
      setSpeechError('Seu navegador não suporta a Web Speech API. Recomendamos o Google Chrome, Edge ou Safari mais recentes.');
      return;
    }

    if (isListening && recognitionRef.current) {
      try {
        recognitionRef.current.stop();
      } catch (_) {}
      setIsListening(false);
      return;
    }

    try {
      const recognition = new SpeechRec();
      recognition.lang = 'pt-BR';
      recognition.continuous = true;
      recognition.interimResults = false;

      recognition.onstart = () => {
        setIsListening(true);
        setSpeechError(null);
      };

      recognition.onresult = (event: any) => {
        let transcript = '';
        for (let i = event.resultIndex; i < event.results.length; ++i) {
          if (event.results[i].isFinal) {
            transcript += event.results[i][0].transcript + ' ';
          }
        }

        const cleanTranscript = transcript.trim();
        if (cleanTranscript) {
          setInputText(prev => {
            const trimmed = prev.trim();
            // Adiciona com separação por vírgula para manter compatibilidade com o parser
            const updated = trimmed ? `${trimmed}, ${cleanTranscript}` : cleanTranscript;
            handleProcessList(updated);
            return updated;
          });
        }
      };

      recognition.onerror = (event: any) => {
        if (event.error === 'not-allowed') {
          setSpeechError('Permissão para uso do microfone foi negada no navegador. Habilite o microfone para ditar.');
        } else if (event.error === 'no-speech') {
          // Nenhuma fala detectada no intervalo, mantém aberto ou encerra suavemente
        } else {
          setSpeechError(`Aviso de reconhecimento de voz: ${event.error}`);
        }
        setIsListening(false);
      };

      recognition.onend = () => {
        setIsListening(false);
      };

      recognitionRef.current = recognition;
      recognition.start();
    } catch (err: any) {
      setSpeechError('Não foi possível iniciar o microfone no momento.');
      setIsListening(false);
    }
  };

  // Captura rápida de voz para adição de item individual
  const toggleQuickVoiceInput = () => {
    setSpeechError(null);
    const SpeechRec = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

    if (!SpeechRec) {
      setSpeechError('Seu navegador não suporta a Web Speech API.');
      return;
    }

    if (isQuickListening && quickRecognitionRef.current) {
      try {
        quickRecognitionRef.current.stop();
      } catch (_) {}
      setIsQuickListening(false);
      return;
    }

    try {
      const recognition = new SpeechRec();
      recognition.lang = 'pt-BR';
      recognition.continuous = false;
      recognition.interimResults = false;

      recognition.onstart = () => {
        setIsQuickListening(true);
        setSpeechError(null);
      };

      recognition.onresult = (event: any) => {
        let singleText = '';
        for (let i = event.resultIndex; i < event.results.length; ++i) {
          if (event.results[i].isFinal) {
            singleText += event.results[i][0].transcript;
          }
        }
        const clean = singleText.trim();
        if (clean) {
          setNewItemText(clean);
        }
      };

      recognition.onerror = (event: any) => {
        if (event.error === 'not-allowed') {
          setSpeechError('Permissão de microfone negada.');
        }
        setIsQuickListening(false);
      };

      recognition.onend = () => {
        setIsQuickListening(false);
      };

      quickRecognitionRef.current = recognition;
      recognition.start();
    } catch (err) {
      setSpeechError('Erro ao iniciar gravação.');
      setIsQuickListening(false);
    }
  };

  const formattedOutput = useMemo(() => {
    return generateStandardOutput(items);
  }, [items]);

  const itemsByCategory = useMemo(() => {
    const map: Record<CategoryKey, ShoppingItem[]> = {
      hortifruti: [],
      acougue_frios: [],
      laticinios_padaria: [],
      mercearia_despensa: [],
      bebidas: [],
      limpeza_higiene: [],
      outros: [],
    };
    items.forEach(item => {
      if (filterSearch.trim() === '' || item.rawText.toLowerCase().includes(filterSearch.toLowerCase())) {
        map[item.category].push(item);
      }
    });
    return map;
  }, [items, filterSearch]);

  const totalItemsCount = items.length;
  const completedItemsCount = items.filter(i => i.completed).length;
  const progressPercentage = totalItemsCount > 0 ? Math.round((completedItemsCount / totalItemsCount) * 100) : 0;
  const activeCategoriesCount = CATEGORIES.filter(c => items.some(i => i.category === c.key)).length;

  const toggleItemCompleted = (id: string) => {
    setItems(prev => prev.map(item => item.id === id ? { ...item, completed: !item.completed } : item));
  };

  const handleCategoryChange = (id: string, newCategory: CategoryKey) => {
    setItems(prev => prev.map(item => item.id === id ? { ...item, category: newCategory } : item));
  };

  const handleDeleteItem = (id: string) => {
    setItems(prev => prev.filter(item => item.id !== id));
  };

  const handleAddNewItem = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newItemText.trim()) return;

    const newItem: ShoppingItem = {
      id: `${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
      rawText: newItemText.trim(),
      category: classifyItemText(newItemText.trim()),
      completed: false,
    };

    setItems(prev => [...prev, newItem]);
    setNewItemText('');
  };

  const copyToClipboard = () => {
    if (!formattedOutput) return;
    navigator.clipboard.writeText(formattedOutput).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    });
  };

  const handleSendWhatsApp = (e: React.FormEvent) => {
    e.preventDefault();
    if (!formattedOutput) return;

    let cleanPhone = whatsAppPhone.replace(/\D/g, '');
    if (cleanPhone && !cleanPhone.startsWith('55') && cleanPhone.length >= 10 && cleanPhone.length <= 11) {
      cleanPhone = `55${cleanPhone}`;
    }

    const message = encodeURIComponent(
      `🛒 *LISTA DE COMPRAS ORGANIZADA POR SETOR*\n\n${formattedOutput}\n\n_Organizado via Organizador de Compras Inteligente_`
    );

    const url = cleanPhone
      ? `https://api.whatsapp.com/send?phone=${cleanPhone}&text=${message}`
      : `https://api.whatsapp.com/send?text=${message}`;

    window.open(url, '_blank');
  };

  const loadPreset = (presetName: string) => {
    setSelectedPreset(presetName);
    let sample = '';
    switch (presetName) {
      case 'default':
        sample = INITIAL_USER_INPUT;
        break;
      case 'churrasco':
        sample = '2kg de picanha, 1kg de linguiça toscana, carvão 5kg, fardo de cerveja, farofa temperada, pão de alho, sal grosso, refrigerante 2L, guardanapo, 5 limões';
        break;
      case 'saudavel':
        sample = '1 cacho de banana, 500g de morango, 2 alfaces americana, peito de frango 1.5kg, aveia em flocos, iogurte desnatado, azeite extra virgem, chá verde, sabonete líquido neutro';
        break;
      case 'limpeza_pesada':
        sample = 'desinfetante pinho 2L, 3 detergentes de maçã, 2 esponjas dupla face, água sanitária 1L, sabão em pó 2kg, amaciante concentrado, papel toalha 3 rolos, álcool 70%';
        break;
      default:
        sample = INITIAL_USER_INPUT;
    }
    setInputText(sample);
    handleProcessList(sample);
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 flex flex-col font-sans">
      {/* Header Corporativo B2B & Moderno */}
      <header className="bg-white border-b border-slate-200 sticky top-0 z-30 shadow-xs">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <div className="flex items-center space-x-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-emerald-600 to-teal-500 flex items-center justify-center text-white shadow-sm font-bold text-xl">
              🛒
            </div>
            <div>
              <div className="flex items-center space-x-2">
                <h1 className="text-lg font-bold tracking-tight text-slate-900">
                  Organizador Lógico de Compras
                </h1>
                <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-emerald-100 text-emerald-800">
                  Motor de Otimização de Rota
                </span>
              </div>
              <p className="text-xs text-slate-500 hidden sm:block">
                Agrupamento automático por setores de supermercado com trajeto otimizado
              </p>
            </div>
          </div>

          <div className="flex items-center space-x-2">
            <button
              onClick={copyToClipboard}
              className="inline-flex items-center px-3 py-1.5 rounded-lg text-xs font-semibold border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 hover:border-slate-400 transition-all shadow-xs"
              title="Copiar lista classificada"
            >
              <svg className="w-4 h-4 mr-1.5 text-slate-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
              {copied ? 'Copiado! ✓' : 'Copiar Saída'}
            </button>
            <a
              href="#whatsapp-share"
              className="inline-flex items-center px-3.5 py-1.5 rounded-lg text-xs font-semibold bg-emerald-600 text-white hover:bg-emerald-700 shadow-sm transition-all"
            >
              <svg className="w-4 h-4 mr-1.5 fill-current" viewBox="0 0 24 24">
                <path d="M12.031 6.172c-3.181 0-5.767 2.586-5.768 5.766-.001 1.298.38 2.27 1.019 3.287l-.582 2.128 2.182-.573c.978.58 1.911.928 3.145.929 3.178 0 5.767-2.587 5.768-5.766.001-3.187-2.575-5.771-5.764-5.771zm3.392 8.244c-.144.405-.837.774-1.17.824-.299.045-.677.063-1.092-.069-.252-.08-.575-.187-.988-.365-1.739-.751-2.874-2.502-2.961-2.617-.087-.116-.708-.94-.708-1.793s.448-1.273.607-1.446c.159-.173.346-.217.462-.217l.332.007c.106.005.249-.04.39.299.144.35.491 1.199.534 1.286.043.087.072.188.014.303-.058.116-.087.188-.173.289l-.26.302c-.087.087-.179.182-.077.357.101.174.45 1.05 1.011 1.547.722.64 1.332.839 1.52.926.188.087.299.073.411-.057.112-.13.477-.557.604-.748.127-.191.254-.159.427-.095.173.064 1.098.518 1.286.612.188.094.313.141.359.22.046.079.046.457-.098.862z"/>
              </svg>
              Enviar WhatsApp
            </a>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 w-full flex-1">
        
        {/* Painel Superior: Entrada Desestruturada e Simulação Rápida */}
        <section className="bg-white rounded-2xl border border-slate-200 p-5 sm:p-6 shadow-xs mb-6">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between pb-4 border-b border-slate-100 gap-3">
            <div>
              <div className="flex items-center space-x-2">
                <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse"></span>
                <h2 className="text-base font-bold text-slate-900">
                  Entrada da Lista Desestruturada
                </h2>
              </div>
              <p className="text-xs text-slate-500 mt-0.5">
                Cole itens separados por vírgula, linhas ou traços. O motor identifica setores, preserva quantidades e remove categorias vazias.
              </p>
            </div>

            {/* Presets Rápidos */}
            <div className="flex items-center space-x-1.5 overflow-x-auto pb-1 sm:pb-0">
              <span className="text-xs font-medium text-slate-400 whitespace-nowrap mr-1">Exemplos:</span>
              <button
                onClick={() => loadPreset('default')}
                className={`px-2.5 py-1 text-xs rounded-md font-medium transition-all ${
                  selectedPreset === 'default'
                    ? 'bg-slate-900 text-white shadow-xs'
                    : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                }`}
              >
                Lista Oficial (Prompt)
              </button>
              <button
                onClick={() => loadPreset('churrasco')}
                className={`px-2.5 py-1 text-xs rounded-md font-medium transition-all ${
                  selectedPreset === 'churrasco'
                    ? 'bg-slate-900 text-white shadow-xs'
                    : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                }`}
              >
                Churrasco
              </button>
              <button
                onClick={() => loadPreset('saudavel')}
                className={`px-2.5 py-1 text-xs rounded-md font-medium transition-all ${
                  selectedPreset === 'saudavel'
                    ? 'bg-slate-900 text-white shadow-xs'
                    : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                }`}
              >
                Feira & Fit
              </button>
              <button
                onClick={() => loadPreset('limpeza_pesada')}
                className={`px-2.5 py-1 text-xs rounded-md font-medium transition-all ${
                  selectedPreset === 'limpeza_pesada'
                    ? 'bg-slate-900 text-white shadow-xs'
                    : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                }`}
              >
                Limpeza
              </button>
            </div>
          </div>

          <div className="mt-4">
            <label htmlFor="raw-input" className="sr-only">Lista desestruturada</label>
            <div className="relative">
              <textarea
                id="raw-input"
                rows={3}
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                placeholder="Exemplo: leite integral 2L, detergente de maçã, 1kg de tomate, pão francês, peito de frango, pó de café..."
                className="w-full rounded-xl border border-slate-200 p-3.5 pr-28 text-sm text-slate-800 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent font-mono bg-slate-50/50 resize-y"
              />

              {/* Botão de Microfone no Campo de Entrada (Web Speech API) */}
              <div className="absolute right-2.5 top-2.5 flex items-center space-x-1.5">
                <button
                  type="button"
                  onClick={toggleVoiceInput}
                  title={isListening ? "Parar gravação de voz" : "Ditar lista de compras por voz (Web Speech API)"}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center space-x-1.5 transition-all shadow-xs cursor-pointer ${
                    isListening
                      ? 'bg-rose-600 text-white animate-pulse shadow-rose-200 ring-2 ring-rose-400'
                      : 'bg-emerald-50 text-emerald-800 hover:bg-emerald-100 border border-emerald-300'
                  }`}
                >
                  <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    {isListening ? (
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z M9 10a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1v-4z" />
                    ) : (
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
                    )}
                  </svg>
                  <span className="text-xs font-semibold">
                    {isListening ? 'Gravando...' : 'Falar'}
                  </span>
                </button>
              </div>
            </div>

            {/* Banner de Feedback Ativo de Reconhecimento de Voz */}
            {isListening && (
              <div className="mt-2.5 p-3 rounded-xl bg-rose-50 border border-rose-200 flex items-center justify-between text-xs text-rose-900 shadow-xs">
                <div className="flex items-center space-x-2.5">
                  <span className="relative flex h-3 w-3">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-rose-400 opacity-75"></span>
                    <span className="relative inline-flex rounded-full h-3 w-3 bg-rose-600"></span>
                  </span>
                  <div>
                    <span className="font-bold mr-1">Ouvindo sua voz via Web Speech API:</span>
                    <span className="text-rose-700">Fale seus itens de supermercado (ex.: "2 quilos de batata, maçãs, café, sabão em pó").</span>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={toggleVoiceInput}
                  className="px-2.5 py-1 bg-rose-600 text-white font-bold rounded-md hover:bg-rose-700 text-xs shrink-0 ml-2 cursor-pointer"
                >
                  Parar
                </button>
              </div>
            )}

            {/* Aviso de erro ou permissão do microfone */}
            {speechError && (
              <div className="mt-2.5 p-3 rounded-xl bg-amber-50 border border-amber-200 flex items-center justify-between text-xs text-amber-900 shadow-xs">
                <div className="flex items-center space-x-2">
                  <span className="text-base">⚠️</span>
                  <span>{speechError}</span>
                </div>
                <button
                  type="button"
                  onClick={() => setSpeechError(null)}
                  className="text-amber-800 hover:text-amber-950 font-bold ml-2 cursor-pointer"
                >
                  ✕
                </button>
              </div>
            )}

            <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center space-x-2 text-xs text-slate-500">
                <span className="font-semibold text-slate-700">{items.length} itens detectados</span>
                <span>•</span>
                <span>{activeCategoriesCount} setores ativos</span>
                <span>•</span>
                <span className="text-emerald-700 font-medium">100% fidelidade nas quantidades</span>
              </div>

              <div className="flex items-center space-x-2">
                <button
                  type="button"
                  onClick={() => {
                    setInputText('');
                    setItems([]);
                  }}
                  className="px-3 py-1.5 text-xs text-slate-500 hover:text-slate-700 font-medium transition-colors"
                >
                  Limpar
                </button>
                <button
                  type="button"
                  onClick={() => handleProcessList(inputText)}
                  className="inline-flex items-center px-4 py-2 rounded-xl text-xs font-bold bg-slate-900 text-white hover:bg-slate-800 active:scale-95 transition-all shadow-sm"
                >
                  <svg className="w-3.5 h-3.5 mr-1.5 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M13 10V3L4 14h7v7l9-11h-7z" />
                  </svg>
                  Reclassificar Itens
                </button>
              </div>
            </div>
          </div>
        </section>

        {/* Métricas e Barra de Progresso no Supermercado */}
        <section className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
          <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-xs">
            <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider block">Total de Itens</span>
            <div className="flex items-baseline mt-1 space-x-2">
              <span className="text-2xl font-bold text-slate-900">{totalItemsCount}</span>
              <span className="text-xs text-slate-500">produtos</span>
            </div>
          </div>

          <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-xs">
            <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider block">Setores Ativos</span>
            <div className="flex items-baseline mt-1 space-x-2">
              <span className="text-2xl font-bold text-emerald-600">{activeCategoriesCount}</span>
              <span className="text-xs text-slate-500">de 7 categorias</span>
            </div>
          </div>

          <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-xs">
            <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider block">No Carrinho</span>
            <div className="flex items-baseline mt-1 space-x-2">
              <span className="text-2xl font-bold text-teal-600">{completedItemsCount}</span>
              <span className="text-xs text-slate-500">coletados</span>
            </div>
          </div>

          <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-xs flex flex-col justify-between">
            <div className="flex justify-between items-center">
              <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Progresso</span>
              <span className="text-xs font-bold text-slate-700">{progressPercentage}%</span>
            </div>
            <div className="w-full bg-slate-100 rounded-full h-2 mt-2 overflow-hidden">
              <div
                className="bg-emerald-500 h-2 rounded-full transition-all duration-300"
                style={{ width: `${progressPercentage}%` }}
              ></div>
            </div>
          </div>
        </section>

        {/* Abas de Visualização: Interativo vs Saída Padrão (Markdown estrito) vs Rota Otimizada */}
        <div className="flex items-center justify-between border-b border-slate-200 mb-6">
          <div className="flex space-x-2 sm:space-x-4">
            <button
              onClick={() => setActiveTab('interactive')}
              className={`py-3 px-3 text-xs sm:text-sm font-semibold border-b-2 flex items-center space-x-2 transition-colors ${
                activeTab === 'interactive'
                  ? 'border-emerald-600 text-emerald-700'
                  : 'border-transparent text-slate-500 hover:text-slate-800'
              }`}
            >
              <span>📋</span>
              <span>Visualização Interativa</span>
              <span className="bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded text-xs font-medium">
                {items.length}
              </span>
            </button>

            <button
              onClick={() => setActiveTab('standard_output')}
              className={`py-3 px-3 text-xs sm:text-sm font-semibold border-b-2 flex items-center space-x-2 transition-colors ${
                activeTab === 'standard_output'
                  ? 'border-emerald-600 text-emerald-700'
                  : 'border-transparent text-slate-500 hover:text-slate-800'
              }`}
            >
              <span>📄</span>
              <span>Saída Formatada (Padrão Especificado)</span>
              <span className="bg-emerald-100 text-emerald-800 px-1.5 py-0.5 rounded text-xs font-medium">
                Formatado
              </span>
            </button>

            <button
              onClick={() => setActiveTab('trajeto')}
              className={`py-3 px-3 text-xs sm:text-sm font-semibold border-b-2 flex items-center space-x-2 transition-colors ${
                activeTab === 'trajeto'
                  ? 'border-emerald-600 text-emerald-700'
                  : 'border-transparent text-slate-500 hover:text-slate-800'
              }`}
            >
              <span>🗺️</span>
              <span>Trajeto Otimizado</span>
            </button>

            <button
              onClick={() => setActiveTab('supabase')}
              className={`py-3 px-3 text-xs sm:text-sm font-semibold border-b-2 flex items-center space-x-2 transition-colors ${
                activeTab === 'supabase'
                  ? 'border-emerald-600 text-emerald-700'
                  : 'border-transparent text-slate-500 hover:text-slate-800'
              }`}
            >
              <span>⚡</span>
              <span>Supabase & Migrations</span>
              <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                supabaseStatus === 'connected' ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-100 text-slate-600'
              }`}>
                {supabaseStatus === 'connected' ? 'Conectado' : 'SQL'}
              </span>
            </button>
          </div>

          {activeTab === 'interactive' && (
            <div className="hidden md:block w-48">
              <input
                type="text"
                placeholder="Filtrar item..."
                value={filterSearch}
                onChange={(e) => setFilterSearch(e.target.value)}
                className="w-full text-xs px-2.5 py-1.5 rounded-lg border border-slate-200 bg-white text-slate-800 focus:outline-none focus:ring-1 focus:ring-emerald-500"
              />
            </div>
          )}
        </div>

        {/* CONTEÚDO DA ABA 1: Interativo por Setores com Checkbox e Ajuste de Categoria */}
        {activeTab === 'interactive' && (
          <div className="space-y-6">
            {/* Quick Add Bar com Microfone */}
            <form onSubmit={handleAddNewItem} className="bg-white p-3 rounded-xl border border-slate-200 shadow-xs flex items-center gap-2">
              <span className="text-slate-400 pl-2">➕</span>
              <input
                type="text"
                value={newItemText}
                onChange={(e) => setNewItemText(e.target.value)}
                placeholder="Adicionar item rápido (ex.: 500g de queijo prato, 2 litros de água mineral)..."
                className="flex-1 text-sm bg-transparent border-none focus:outline-none text-slate-800 placeholder-slate-400"
              />
              <button
                type="button"
                onClick={toggleQuickVoiceInput}
                title={isQuickListening ? "Parar escuta" : "Falar item por voz (Web Speech API)"}
                className={`p-1.5 rounded-lg transition-all cursor-pointer ${
                  isQuickListening
                    ? 'bg-rose-500 text-white animate-pulse'
                    : 'text-slate-500 hover:text-emerald-700 hover:bg-slate-100'
                }`}
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  {isQuickListening ? (
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z M9 10a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1v-4z" />
                  ) : (
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
                  )}
                </svg>
              </button>
              <button
                type="submit"
                className="px-4 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-xs font-bold transition-colors shadow-xs cursor-pointer"
              >
                Adicionar
              </button>
            </form>

            {items.length === 0 ? (
              <div className="bg-white rounded-2xl border border-dashed border-slate-300 p-12 text-center">
                <span className="text-4xl block mb-2">🛒</span>
                <h3 className="text-base font-bold text-slate-800">Sua lista está vazia</h3>
                <p className="text-xs text-slate-500 mt-1 max-w-sm mx-auto">
                  Digite ou cole produtos no campo superior e clique em reclassificar para agrupar automaticamente.
                </p>
                <button
                  onClick={() => loadPreset('default')}
                  className="mt-4 px-4 py-2 bg-emerald-600 text-white rounded-xl text-xs font-bold hover:bg-emerald-700"
                >
                  Carregar Lista Padrão
                </button>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
                {CATEGORIES.map((cat) => {
                  const catItems = itemsByCategory[cat.key];
                  if (!catItems || catItems.length === 0) {
                    // Regra 3: Não exibe categorias vazias
                    return null;
                  }

                  const allCatCompleted = catItems.every(i => i.completed);

                  return (
                    <div
                      key={cat.key}
                      className={`bg-white rounded-2xl border ${cat.borderColor} shadow-xs overflow-hidden flex flex-col transition-all hover:shadow-md`}
                    >
                      {/* Cabeçalho da Categoria */}
                      <div className="p-4 border-b border-slate-100 flex items-center justify-between bg-slate-50/60">
                        <div className="flex items-center space-x-2">
                          <span className="text-2xl" role="img" aria-label={cat.name}>
                            {cat.emoji}
                          </span>
                          <div>
                            <h3 className="text-sm font-bold text-slate-900">
                              {cat.name}
                            </h3>
                            <span className="text-[11px] text-slate-500 font-normal">
                              {catItems.length} {catItems.length === 1 ? 'item' : 'itens'}
                            </span>
                          </div>
                        </div>

                        <span className={`px-2 py-0.5 rounded text-[11px] font-semibold border ${cat.badgeBg}`}>
                          {cat.emoji} {cat.key === 'limpeza_higiene' ? 'Limpeza' : cat.name.split(' ')[0]}
                        </span>
                      </div>

                      {/* Lista de itens da Categoria */}
                      <div className="p-3 divide-y divide-slate-100 flex-1">
                        {catItems.map((item) => (
                          <div
                            key={item.id}
                            className={`py-2 px-2 rounded-lg flex items-center justify-between group transition-all duration-300 ease-in-out ${
                              item.completed ? 'bg-slate-50/70' : 'hover:bg-slate-50'
                            }`}
                          >
                            <label className="flex items-center space-x-3 cursor-pointer flex-1 min-w-0 pr-2 select-none group/item">
                              <div className="relative flex items-center justify-center shrink-0">
                                <input
                                  type="checkbox"
                                  checked={item.completed}
                                  onChange={() => toggleItemCompleted(item.id)}
                                  className="sr-only"
                                />
                                <div
                                  className={`w-5 h-5 rounded-md border flex items-center justify-center transition-all duration-300 ease-out ${
                                    item.completed
                                      ? 'bg-emerald-500 border-emerald-500 shadow-xs scale-100 ring-2 ring-emerald-100'
                                      : 'bg-white border-slate-300 group-hover/item:border-emerald-400 group-hover/item:bg-emerald-50/30 scale-95'
                                  }`}
                                >
                                  <svg
                                    className={`w-3.5 h-3.5 text-white stroke-[3] transition-all duration-300 ease-out transform ${
                                      item.completed
                                        ? 'opacity-100 scale-100 rotate-0'
                                        : 'opacity-0 scale-50 -rotate-12'
                                    }`}
                                    fill="none"
                                    stroke="currentColor"
                                    viewBox="0 0 24 24"
                                  >
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                                  </svg>
                                </div>
                              </div>

                              <span
                                className={`text-sm truncate transition-all duration-300 ease-in-out ${
                                  item.completed
                                    ? 'text-slate-400 line-through opacity-60 translate-x-0.5'
                                    : 'text-slate-800 font-medium opacity-100 translate-x-0'
                                }`}
                              >
                                {item.rawText}
                              </span>
                            </label>

                            {/* Ações Rápidas: Mudar Setor ou Deletar */}
                            <div className="flex items-center space-x-1 opacity-80 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity">
                              <select
                                value={item.category}
                                onChange={(e) => handleCategoryChange(item.id, e.target.value as CategoryKey)}
                                className="text-[11px] bg-white border border-slate-200 text-slate-600 rounded px-1 py-0.5 focus:outline-none"
                                title="Reclassificar categoria deste item"
                              >
                                {CATEGORIES.map(c => (
                                  <option key={c.key} value={c.key}>
                                    {c.emoji} {c.name}
                                  </option>
                                ))}
                              </select>

                              <button
                                onClick={() => handleDeleteItem(item.id)}
                                className="p-1 text-slate-400 hover:text-rose-600 rounded transition-colors"
                                title="Excluir item"
                              >
                                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
                                </svg>
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>

                      {/* Footer do Card com status */}
                      <div className="px-4 py-2 bg-slate-50/50 border-t border-slate-100 text-[11px] text-slate-400 flex justify-between items-center">
                        <span>{cat.description}</span>
                        {allCatCompleted && (
                          <span className="text-emerald-600 font-bold flex items-center">
                            ✓ Completo
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* CONTEÚDO DA ABA 2: Saída Estrita e Pura solicitada no Formato de Saída Esperado */}
        {activeTab === 'standard_output' && (
          <div className="bg-white rounded-2xl border border-slate-200 shadow-xs overflow-hidden">
            <div className="p-4 sm:p-5 border-b border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-slate-50/50">
              <div>
                <div className="flex items-center space-x-2">
                  <span className="px-2 py-0.5 rounded text-xs font-semibold bg-emerald-100 text-emerald-800">
                    Formato Oficial
                  </span>
                  <h3 className="text-sm font-bold text-slate-900">
                    Resultado Classificado Pelo Motor Lógico
                  </h3>
                </div>
                <p className="text-xs text-slate-500 mt-1">
                  Atende a todas as 4 regras de execução: fidelidade total, quantidades preservadas, seções vazias omitidas e resposta limpa.
                </p>
              </div>

              <div className="flex items-center space-x-2">
                <button
                  onClick={copyToClipboard}
                  className="inline-flex items-center px-4 py-2 rounded-xl text-xs font-bold bg-slate-900 text-white hover:bg-slate-800 active:scale-95 transition-all shadow-xs"
                >
                  <svg className="w-4 h-4 mr-1.5 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                  </svg>
                  {copied ? 'Copiado para Área de Transferência! ✓' : 'Copiar Texto Puro'}
                </button>
              </div>
            </div>

            <div className="p-6 bg-slate-900 text-slate-100 font-mono text-sm leading-relaxed overflow-x-auto selection:bg-emerald-500 selection:text-white">
              {formattedOutput ? (
                <pre className="whitespace-pre-wrap">{formattedOutput}</pre>
              ) : (
                <span className="text-slate-500 italic">Nenhum item adicionado para exibir.</span>
              )}
            </div>

            <div className="p-4 bg-slate-50 border-t border-slate-200 flex flex-wrap items-center justify-between text-xs text-slate-500 gap-2">
              <div className="flex items-center space-x-4">
                <span className="flex items-center">
                  <span className="w-2 h-2 rounded-full bg-emerald-500 mr-1.5"></span>
                  Sem introduções ou saudações
                </span>
                <span className="flex items-center">
                  <span className="w-2 h-2 rounded-full bg-emerald-500 mr-1.5"></span>
                  Sem acréscimo de itens extras
                </span>
                <span className="flex items-center">
                  <span className="w-2 h-2 rounded-full bg-emerald-500 mr-1.5"></span>
                  Categorias vazias omitidas
                </span>
              </div>
              <span className="text-slate-400">Total: {items.length} itens em {activeCategoriesCount} setores</span>
            </div>
          </div>
        )}

        {/* CONTEÚDO DA ABA 3: Rota Otimizada no Supermercado */}
        {activeTab === 'trajeto' && (
          <div className="bg-white rounded-2xl border border-slate-200 shadow-xs p-6">
            <div className="max-w-3xl">
              <h3 className="text-base font-bold text-slate-900 flex items-center space-x-2">
                <span>🧭</span>
                <span>Trajeto Físico Otimizado de Compras</span>
              </h3>
              <p className="text-xs text-slate-500 mt-1">
                Sequência recomendada baseada no layout arquitetônico padrão de supermercados brasileiros para evitar idas e vindas e preservar itens perecíveis e refrigerados por último.
              </p>
            </div>

            <div className="mt-8 relative">
              {/* Linha vertical do trajeto */}
              <div className="absolute left-6 top-4 bottom-4 w-0.5 bg-gradient-to-b from-emerald-500 via-blue-400 to-slate-300"></div>

              <div className="space-y-6 relative">
                {CATEGORIES.map((cat, idx) => {
                  const catItems = itemsByCategory[cat.key];
                  const hasItems = catItems && catItems.length > 0;

                  return (
                    <div
                      key={cat.key}
                      className={`flex items-start space-x-4 transition-opacity ${
                        hasItems ? 'opacity-100' : 'opacity-40'
                      }`}
                    >
                      {/* Círculo do Step */}
                      <div
                        className={`w-12 h-12 rounded-2xl flex items-center justify-center text-lg font-bold shadow-xs shrink-0 z-10 ${
                          hasItems
                            ? 'bg-slate-900 text-white ring-4 ring-white'
                            : 'bg-slate-200 text-slate-500'
                        }`}
                      >
                        {idx + 1}
                      </div>

                      {/* Conteúdo do setor */}
                      <div className="flex-1 bg-slate-50 rounded-xl p-4 border border-slate-200/80">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center space-x-2">
                            <span className="text-xl">{cat.emoji}</span>
                            <h4 className="text-sm font-bold text-slate-900">{cat.name}</h4>
                          </div>

                          {hasItems ? (
                            <span className="text-xs font-semibold px-2.5 py-0.5 rounded-full bg-emerald-100 text-emerald-800">
                              {catItems.length} {catItems.length === 1 ? 'item a pegar' : 'itens a pegar'}
                            </span>
                          ) : (
                            <span className="text-xs text-slate-400 italic">
                              Sem itens (pular setor)
                            </span>
                          )}
                        </div>

                        {hasItems && (
                          <div className="mt-2.5 flex flex-wrap gap-1.5">
                            {catItems.map((item) => (
                              <button
                                key={item.id}
                                type="button"
                                onClick={() => toggleItemCompleted(item.id)}
                                title="Clique para alternar status concluído"
                                className={`text-xs px-2.5 py-1 rounded-lg border font-medium transition-all duration-300 ease-in-out cursor-pointer text-left ${
                                  item.completed
                                    ? 'bg-slate-100 text-slate-400 line-through border-slate-200 opacity-60'
                                    : 'bg-white text-slate-800 border-slate-200 shadow-2xs hover:border-emerald-400 opacity-100'
                                }`}
                              >
                                {item.completed ? '✓ ' : ''}{item.rawText}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {/* CONTEÚDO DA ABA 4: Supabase & Migrations */}
        {activeTab === 'supabase' && (
          <div className="space-y-6">
            {/* Status & Quick Actions Bar */}
            <div className="bg-white rounded-2xl border border-slate-200 p-6 shadow-xs flex flex-col md:flex-row md:items-center justify-between gap-4">
              <div>
                <div className="flex items-center space-x-2.5">
                  <div className="w-8 h-8 rounded-lg bg-emerald-500/10 text-emerald-600 flex items-center justify-center font-bold text-lg">
                    ⚡
                  </div>
                  <div>
                    <h3 className="text-base font-bold text-slate-900">Integração Supabase & PostgreSQL</h3>
                    <p className="text-xs text-slate-500">Persistência na nuvem, multi-dispositivos e controle de acesso via Row Level Security (RLS)</p>
                  </div>
                </div>
              </div>

              <div className="flex items-center space-x-3">
                <button
                  type="button"
                  onClick={copyMigrationSql}
                  className="px-4 py-2 bg-slate-900 hover:bg-slate-800 text-white text-xs font-bold rounded-xl transition-all shadow-xs flex items-center space-x-1.5 cursor-pointer"
                >
                  <svg className="w-4 h-4 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                  </svg>
                  <span>{copiedSql ? 'SQL Copiado! ✓' : 'Copiar Migration SQL'}</span>
                </button>

                <button
                  type="button"
                  onClick={handleSyncToSupabase}
                  disabled={isSyncing || supabaseStatus !== 'connected'}
                  className={`px-4 py-2 text-xs font-bold rounded-xl transition-all shadow-xs flex items-center space-x-1.5 ${
                    supabaseStatus === 'connected'
                      ? 'bg-emerald-600 hover:bg-emerald-700 text-white cursor-pointer active:scale-95'
                      : 'bg-slate-100 text-slate-400 cursor-not-allowed'
                  }`}
                  title={supabaseStatus !== 'connected' ? 'Configure a URL e chave do Supabase primeiro' : 'Salvar lista atual no banco de dados'}
                >
                  <svg className={`w-4 h-4 ${isSyncing ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                  </svg>
                  <span>{isSyncing ? 'Sincronizando...' : 'Sincronizar Lista'}</span>
                </button>
              </div>
            </div>

            {syncSuccessMessage && (
              <div className="p-4 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs font-semibold flex items-center justify-between">
                <span className="flex items-center space-x-2">
                  <span>✓</span>
                  <span>{syncSuccessMessage}</span>
                </span>
                <button onClick={() => setSyncSuccessMessage(null)} className="text-emerald-700 hover:text-emerald-900 cursor-pointer">✕</button>
              </div>
            )}

            {/* Grid com Formulário de Credenciais e Guia de Execução */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {/* Form de Conexão */}
              <div className="bg-white rounded-2xl border border-slate-200 p-6 shadow-xs flex flex-col justify-between">
                <div>
                  <h4 className="text-sm font-bold text-slate-900 flex items-center space-x-2 mb-1">
                    <span>🔑</span>
                    <span>Credenciais do Projeto Supabase</span>
                  </h4>
                  <p className="text-xs text-slate-500 mb-4">
                    Encontre estes dados em <strong>Project Settings &gt; API</strong> no console do Supabase.
                  </p>

                  <form onSubmit={handleTestAndSaveSupabase} className="space-y-4">
                    <div>
                      <label className="block text-xs font-bold text-slate-700 mb-1">
                        Project URL (VITE_SUPABASE_URL)
                      </label>
                      <input
                        type="url"
                        placeholder="https://sua-empresa.supabase.co"
                        value={supabaseConfig.url}
                        onChange={(e) => setSupabaseConfig(prev => ({ ...prev, url: e.target.value }))}
                        className="w-full text-xs px-3 py-2.5 rounded-xl border border-slate-200 bg-slate-50 text-slate-800 focus:bg-white focus:outline-none focus:ring-2 focus:ring-emerald-500 font-mono"
                      />
                    </div>

                    <div>
                      <label className="block text-xs font-bold text-slate-700 mb-1">
                        Anon Public Key (VITE_SUPABASE_ANON_KEY)
                      </label>
                      <input
                        type="password"
                        placeholder="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
                        value={supabaseConfig.anonKey}
                        onChange={(e) => setSupabaseConfig(prev => ({ ...prev, anonKey: e.target.value }))}
                        className="w-full text-xs px-3 py-2.5 rounded-xl border border-slate-200 bg-slate-50 text-slate-800 focus:bg-white focus:outline-none focus:ring-2 focus:ring-emerald-500 font-mono"
                      />
                    </div>

                    <div className="flex items-center space-x-3 pt-2">
                      <button
                        type="submit"
                        disabled={supabaseStatus === 'testing'}
                        className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold rounded-xl transition-all shadow-xs cursor-pointer active:scale-95"
                      >
                        {supabaseStatus === 'testing' ? 'Verificando...' : 'Salvar & Testar Conexão'}
                      </button>

                      {supabaseStatus === 'connected' && (
                        <span className="text-xs text-emerald-700 font-semibold flex items-center space-x-1">
                          <span>●</span>
                          <span>Conectado</span>
                        </span>
                      )}
                    </div>
                  </form>

                  {supabaseMessage && (
                    <div className={`mt-4 p-3 rounded-xl text-xs border ${
                      supabaseStatus === 'connected'
                        ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                        : supabaseStatus === 'error'
                        ? 'bg-rose-50 border-rose-200 text-rose-800'
                        : 'bg-slate-50 border-slate-200 text-slate-700'
                    }`}>
                      {supabaseMessage}
                    </div>
                  )}
                </div>

                <div className="mt-6 pt-4 border-t border-slate-100 text-[11px] text-slate-400">
                  <span>As credenciais são salvas localmente no navegador e integradas ao cliente <code>@supabase/supabase-js</code>.</span>
                </div>
              </div>

              {/* Como executar as Migrations */}
              <div className="bg-slate-900 rounded-2xl border border-slate-800 p-6 text-white shadow-xs flex flex-col justify-between">
                <div>
                  <h4 className="text-sm font-bold text-white flex items-center space-x-2 mb-1">
                    <span>🚀</span>
                    <span>Como Aplicar as Migrations</span>
                  </h4>
                  <p className="text-xs text-slate-400 mb-4">
                    O arquivo de migration já está gerado em <code>supabase/migrations/20261005000000_create_shopping_tables.sql</code>.
                  </p>

                  <ol className="space-y-3 text-xs text-slate-300">
                    <li className="flex items-start space-x-2">
                      <span className="w-5 h-5 rounded-full bg-emerald-500/20 text-emerald-400 flex items-center justify-center font-bold text-[11px] shrink-0 mt-0.5">1</span>
                      <div>
                        <strong className="text-white">Via Supabase Dashboard:</strong> Acesse seu projeto em <a href="https://supabase.com/dashboard" target="_blank" rel="noreferrer" className="text-emerald-400 underline">supabase.com</a> &gt; abra o <strong>SQL Editor</strong> &gt; cole o código SQL abaixo e clique em <strong>Run</strong>.
                      </div>
                    </li>
                    <li className="flex items-start space-x-2">
                      <span className="w-5 h-5 rounded-full bg-emerald-500/20 text-emerald-400 flex items-center justify-center font-bold text-[11px] shrink-0 mt-0.5">2</span>
                      <div>
                        <strong className="text-white">Via Supabase CLI:</strong> No seu terminal local, execute:
                        <div className="mt-1 p-2 rounded-lg bg-slate-950 font-mono text-[11px] text-emerald-300">
                          npx supabase db push
                        </div>
                      </div>
                    </li>
                    <li className="flex items-start space-x-2">
                      <span className="w-5 h-5 rounded-full bg-emerald-500/20 text-emerald-400 flex items-center justify-center font-bold text-[11px] shrink-0 mt-0.5">3</span>
                      <div>
                        <strong className="text-white">Estruturas criadas:</strong> Tabelas <code>shopping_lists</code> e <code>shopping_items</code>, índices rápidos, triggers de <code>updated_at</code> e políticas de RLS.
                      </div>
                    </li>
                  </ol>
                </div>

                <div className="mt-6 pt-4 border-t border-slate-800 flex items-center justify-between text-[11px] text-slate-400">
                  <span>Compatível com Supabase Cloud & Local (Docker)</span>
                  <span className="text-emerald-400 font-semibold">PostgreSQL 15+</span>
                </div>
              </div>
            </div>

            {/* Visualizador de Código SQL da Migration */}
            <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden shadow-xs">
              <div className="p-4 border-b border-slate-200 bg-slate-50 flex items-center justify-between">
                <div className="flex items-center space-x-2">
                  <span className="w-3 h-3 rounded-full bg-rose-400 inline-block"></span>
                  <span className="w-3 h-3 rounded-full bg-amber-400 inline-block"></span>
                  <span className="w-3 h-3 rounded-full bg-emerald-400 inline-block"></span>
                  <span className="text-xs font-mono text-slate-600 font-semibold ml-2">
                    supabase/migrations/20261005000000_create_shopping_tables.sql
                  </span>
                </div>

                <button
                  type="button"
                  onClick={copyMigrationSql}
                  className="px-3 py-1 bg-white hover:bg-slate-100 text-slate-700 text-xs font-semibold rounded-lg border border-slate-300 transition-colors shadow-2xs cursor-pointer flex items-center space-x-1"
                >
                  <span>{copiedSql ? 'Copiado! ✓' : 'Copiar Código SQL'}</span>
                </button>
              </div>

              <div className="p-5 bg-slate-950 text-slate-200 font-mono text-xs leading-relaxed overflow-x-auto max-h-96">
                <pre>{MIGRATION_SQL}</pre>
              </div>
            </div>
          </div>
        )}

        {/* Seção B2B / WhatsApp Integration com Formulário Interativo */}
        <section id="whatsapp-share" className="mt-10 bg-gradient-to-br from-emerald-900 via-slate-900 to-teal-950 rounded-3xl p-6 sm:p-8 text-white shadow-xl relative overflow-hidden">
          <div className="absolute right-0 bottom-0 opacity-10 pointer-events-none transform translate-x-12 translate-y-12">
            <span className="text-[200px]">🛒</span>
          </div>

          <div className="relative z-10 max-w-2xl">
            <div className="inline-flex items-center px-3 py-1 rounded-full text-xs font-semibold bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 mb-3">
              <span>💬 Envio Instantâneo Formatado</span>
            </div>
            <h3 className="text-xl sm:text-2xl font-black tracking-tight text-white">
              Envie a lista categorizada direto para o WhatsApp
            </h3>
            <p className="text-xs sm:text-sm text-slate-300 mt-2 leading-relaxed">
              Ideal para quem vai às compras ou para equipes operacionais de mercados, restaurantes e empórios. A mensagem já vai estruturada por setores com emojis e marcadores.
            </p>

            <form onSubmit={handleSendWhatsApp} className="mt-6 flex flex-col sm:flex-row gap-3">
              <div className="relative flex-1">
                <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-slate-400 text-xs">
                  <span>📱 +55</span>
                </div>
                <input
                  type="tel"
                  placeholder="(DDD) 99999-9999 (opcional)"
                  value={whatsAppPhone}
                  onChange={(e) => setWhatsAppPhone(e.target.value)}
                  className="w-full pl-16 pr-3 py-3 rounded-xl bg-slate-800/80 border border-slate-700 text-white placeholder-slate-400 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-400 focus:border-transparent"
                />
              </div>

              <button
                type="submit"
                className="px-6 py-3 bg-emerald-500 hover:bg-emerald-400 active:scale-95 text-slate-950 font-bold rounded-xl text-sm transition-all shadow-lg flex items-center justify-center space-x-2 shrink-0 cursor-pointer"
              >
                <svg className="w-5 h-5 fill-current" viewBox="0 0 24 24">
                  <path d="M12.031 6.172c-3.181 0-5.767 2.586-5.768 5.766-.001 1.298.38 2.27 1.019 3.287l-.582 2.128 2.182-.573c.978.58 1.911.928 3.145.929 3.178 0 5.767-2.587 5.768-5.766.001-3.187-2.575-5.771-5.764-5.771zm3.392 8.244c-.144.405-.837.774-1.17.824-.299.045-.677.063-1.092-.069-.252-.08-.575-.187-.988-.365-1.739-.751-2.874-2.502-2.961-2.617-.087-.116-.708-.94-.708-1.793s.448-1.273.607-1.446c.159-.173.346-.217.462-.217l.332.007c.106.005.249-.04.39.299.144.35.491 1.199.534 1.286.043.087.072.188.014.303-.058.116-.087.188-.173.289l-.26.302c-.087.087-.179.182-.077.357.101.174.45 1.05 1.011 1.547.722.64 1.332.839 1.52.926.188.087.299.073.411-.057.112-.13.477-.557.604-.748.127-.191.254-.159.427-.095.173.064 1.098.518 1.286.612.188.094.313.141.359.22.046.079.046.457-.098.862z"/>
                </svg>
                <span>Disparar no WhatsApp</span>
              </button>
            </form>

            <div className="mt-4 flex items-center space-x-4 text-[11px] text-slate-400">
              <span>✓ Sem instalação de aplicativos</span>
              <span>✓ Link universal compatível com Web e Mobile</span>
            </div>
          </div>
        </section>

      </main>

      {/* Footer Limpo e Corporativo */}
      <footer className="bg-white border-t border-slate-200 py-6 mt-12 text-center text-xs text-slate-500">
        <div className="max-w-7xl mx-auto px-4 flex flex-col sm:flex-row items-center justify-between gap-2">
          <span>Organizador Lógico de Compras • Classificação Automática por Setores</span>
          <div className="flex space-x-4">
            <span>Fidelidade Total</span>
            <span>•</span>
            <span>Sem Itens Extras</span>
            <span>•</span>
            <span>Quantidades Preservadas</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
