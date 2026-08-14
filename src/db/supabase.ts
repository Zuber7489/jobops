import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { CONFIG } from '../config';

let supabaseClient: SupabaseClient | null = null;

export function getSupabaseClient(): SupabaseClient | null {
  const url = process.env.SUPABASE_URL || 'https://kiufbkzgwbiapvfkvcr.supabase.co';
  const key = process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY;

  if (!key) {
    return null;
  }

  if (!supabaseClient) {
    supabaseClient = createClient(url, key);
  }
  return supabaseClient;
}

export async function syncJobToSupabase(job: any) {
  const supabase = getSupabaseClient();
  if (!supabase) return;

  try {
    const { error } = await supabase.from('jobs').upsert({
      platform: job.platform,
      external_job_id: job.external_job_id,
      title: job.title,
      company: job.company,
      location: job.location,
      url: job.url,
      jd_text: job.jd_text,
      apply_type: job.apply_type,
      score: job.score,
      evaluation_reason: job.evaluation_reason,
      status: job.status
    }, { onConflict: 'external_job_id' });

    if (error) {
      console.warn(`⚠️ [Supabase Sync Note]: ${error.message}`);
    } else {
      console.log(`☁️ [Supabase Synced] Job: "${job.title}" @ ${job.company}`);
    }
  } catch (e: any) {
    console.warn(`⚠️ [Supabase Error]: ${e.message}`);
  }
}
