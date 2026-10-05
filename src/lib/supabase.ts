import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { CategoryKey } from '../App';

export interface DatabaseShoppingList {
  id: string;
  user_id?: string | null;
  title: string;
  raw_input: string;
  active_sectors: number;
  total_items: number;
  created_at?: string;
  updated_at?: string;
}

export interface DatabaseShoppingItem {
  id: string;
  list_id: string;
  raw_text: string;
  category: CategoryKey;
  completed: boolean;
  position: number;
  created_at?: string;
  updated_at?: string;
}

// Chaves para armazenamento local da configuração do Supabase
const LOCAL_STORAGE_URL_KEY = 'supabase_project_url';
const LOCAL_STORAGE_ANON_KEY = 'supabase_anon_key';

export function getStoredSupabaseConfig(): { url: string; anonKey: string } {
  const envUrl = (import.meta as any).env?.VITE_SUPABASE_URL || '';
  const envKey = (import.meta as any).env?.VITE_SUPABASE_ANON_KEY || '';

  const storedUrl = typeof window !== 'undefined' ? localStorage.getItem(LOCAL_STORAGE_URL_KEY) || '' : '';
  const storedKey = typeof window !== 'undefined' ? localStorage.getItem(LOCAL_STORAGE_ANON_KEY) || '' : '';

  return {
    url: storedUrl || envUrl,
    anonKey: storedKey || envKey,
  };
}

export function saveStoredSupabaseConfig(url: string, anonKey: string): void {
  if (typeof window !== 'undefined') {
    if (url.trim()) {
      localStorage.setItem(LOCAL_STORAGE_URL_KEY, url.trim());
    } else {
      localStorage.removeItem(LOCAL_STORAGE_URL_KEY);
    }

    if (anonKey.trim()) {
      localStorage.setItem(LOCAL_STORAGE_ANON_KEY, anonKey.trim());
    } else {
      localStorage.removeItem(LOCAL_STORAGE_ANON_KEY);
    }
  }
}

let cachedClient: SupabaseClient | null = null;
let currentClientKey = '';

export function getSupabaseClient(): SupabaseClient | null {
  const { url, anonKey } = getStoredSupabaseConfig();

  if (!url || !anonKey) {
    return null;
  }

  const keyCombination = `${url}:${anonKey}`;
  if (cachedClient && currentClientKey === keyCombination) {
    return cachedClient;
  }

  try {
    cachedClient = createClient(url, anonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
      },
    });
    currentClientKey = keyCombination;
    return cachedClient;
  } catch (err) {
    console.warn('Erro ao inicializar Supabase client:', err);
    return null;
  }
}

// Testa a conexão com o Supabase
export async function testSupabaseConnection(url: string, anonKey: string): Promise<{ success: boolean; message: string }> {
  try {
    const client = createClient(url, anonKey);
    const { data, error } = await client.from('shopping_lists').select('id').limit(1);

    if (error) {
      // Se a tabela ainda não existe mas as credenciais são válidas
      if (error.code === '42P01' || error.message.includes('relation "public.shopping_lists" does not exist')) {
        return {
          success: true,
          message: 'Conexão autenticada com sucesso! Lembre-se de rodar o arquivo de migrations para criar as tabelas.',
        };
      }
      return {
        success: false,
        message: `Erro do Supabase: ${error.message}`,
      };
    }

    return {
      success: true,
      message: 'Conexão e tabelas validadas com sucesso no Supabase!',
    };
  } catch (err: any) {
    return {
      success: false,
      message: err.message || 'Falha ao conectar com o Supabase.',
    };
  }
}

// Salva a lista completa no Supabase
export async function syncShoppingListToSupabase(
  rawInput: string,
  items: Array<{ rawText: string; category: CategoryKey; completed: boolean }>,
  title: string = 'Minha Lista de Supermercado'
): Promise<{ success: boolean; listId?: string; error?: string }> {
  const client = getSupabaseClient();
  if (!client) {
    return { success: false, error: 'Supabase não configurado. Adicione a URL e a Anon Key no painel.' };
  }

  try {
    // 1. Cria a lista
    const activeSectors = new Set(items.map(i => i.category)).size;
    const { data: listData, error: listError } = await client
      .from('shopping_lists')
      .insert({
        title,
        raw_input: rawInput,
        active_sectors: activeSectors,
        total_items: items.length,
      })
      .select('id')
      .single();

    if (listError) {
      throw listError;
    }

    const listId = listData.id;

    // 2. Insere os itens vinculados
    if (items.length > 0) {
      const itemsPayload = items.map((item, idx) => ({
        list_id: listId,
        raw_text: item.rawText,
        category: item.category,
        completed: item.completed,
        position: idx,
      }));

      const { error: itemsError } = await client
        .from('shopping_items')
        .insert(itemsPayload);

      if (itemsError) {
        throw itemsError;
      }
    }

    return { success: true, listId };
  } catch (err: any) {
    console.error('Erro ao sincronizar com Supabase:', err);
    return {
      success: false,
      error: err.message || 'Erro ao sincronizar dados com o Supabase.',
    };
  }
}

// Atualiza o status concluído de um item no Supabase
export async function updateItemCompletedInSupabase(
  itemId: string,
  completed: boolean
): Promise<boolean> {
  const client = getSupabaseClient();
  if (!client) return false;

  try {
    const { error } = await client
      .from('shopping_items')
      .update({ completed })
      .eq('id', itemId);

    return !error;
  } catch (err) {
    console.error('Erro ao atualizar item no Supabase:', err);
    return false;
  }
}
