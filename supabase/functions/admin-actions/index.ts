import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function reponseJson(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}

function obtenirCleSecrete(): string | null {
  const ancienneCle = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (ancienneCle) return ancienneCle;

  const clesJson = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (!clesJson) return null;

  try {
    const cles = JSON.parse(clesJson);
    return cles.default || null;
  } catch {
    return null;
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return reponseJson({ error: "Méthode non autorisée." }, 405);
  }

  try {
    const body = await req.json();
    const motDePasseSaisi = body?.password;
    const motDePasseSecret = Deno.env.get("ADMIN_PASSWORD");

    if (!motDePasseSecret) {
      console.error("Secret ADMIN_PASSWORD absent.");
      return reponseJson({ error: "Le secret ADMIN_PASSWORD est absent." }, 500);
    }

    if (typeof motDePasseSaisi !== "string" || motDePasseSaisi !== motDePasseSecret) {
      return reponseJson({ authorized: false }, 200);
    }

    const action = body?.action;

    if (action === "verify_admin") {
      return reponseJson({ authorized: true }, 200);
    }

    const projectUrl = Deno.env.get("SUPABASE_URL");
    const serviceKey = obtenirCleSecrete();

    if (!projectUrl || !serviceKey) {
      console.error("Configuration serveur Supabase manquante.");
      return reponseJson({ error: "La fonction n’a pas accès à sa clé secrète Supabase." }, 500);
    }

    const supabaseAdmin = createClient(projectUrl, serviceKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    });

    if (action === "get_session_stats") {
      const sessionId = body?.sessionId;
      if (!["session-mardi", "session-jeudi"].includes(sessionId)) {
        return reponseJson({ error: "Identifiant de session invalide." }, 400);
      }

      const [{ data: events, error: eventsError }, { data: activeVotes, error: votesError }, { data: session, error: sessionError }] = await Promise.all([
        supabaseAdmin.from("inscription_evenements").select("*").eq("session_id", sessionId).order("created_at", { ascending: true }),
        supabaseAdmin.from("inscriptions").select("id,session_id,prenom,nom,est_invite,invite_par_nom,est_abonne,statut,date_demande").eq("session_id", sessionId).order("date_demande", { ascending: true }),
        supabaseAdmin.from("sessions").select("nom,debut_date,horaires").eq("id", sessionId).maybeSingle(),
      ]);
      if (eventsError) throw eventsError;
      if (votesError) throw votesError;
      if (sessionError) throw sessionError;

      const actifs = activeVotes || [];
      const actifsParId = new Set(actifs.map(vote => String(vote.id)));
      const lignes = [...(events || [])].map(event => ({ ...event, actif: event.type_evenement === "vote" && actifsParId.has(String(event.inscription_id)), ancien_enregistrement: false }));
      const votesJournalises = new Set(lignes.filter(event => event.type_evenement === "vote").map(event => String(event.inscription_id)));
      for (const vote of actifs) {
        if (votesJournalises.has(String(vote.id))) continue;
        lignes.push({ inscription_id: vote.id, session_id: vote.session_id, session_nom: session?.nom || null, session_debut_date: session?.debut_date || null, session_horaires: session?.horaires || null, prenom: vote.prenom, nom: vote.nom, est_invite: vote.est_invite === true, invite_par_nom: vote.invite_par_nom || null, est_abonne: vote.est_abonne === true, type_evenement: "vote", statut: vote.statut, date_demande: vote.date_demande, created_at: null, acteur: vote.est_invite ? (vote.invite_par_nom || null) : `${vote.prenom} ${vote.nom}`, actif: true, ancien_enregistrement: true });
      }
      return reponseJson({ authorized: true, sessionId, session, activeCount: actifs.length, events: lignes, generatedAt: new Date().toISOString() }, 200);
    }
    if (action === "get_all_admin_stats") {
      const sessionIds = ["session-mardi", "session-jeudi"];
      const [{ data: events, error: eventsError }, { data: activeVotes, error: votesError }, { data: sessions, error: sessionsError }] = await Promise.all([
        supabaseAdmin.from("inscription_evenements").select("*").in("session_id", sessionIds).order("created_at", { ascending: true }),
        supabaseAdmin.from("inscriptions").select("id,session_id,prenom,nom,est_invite,invite_par_nom,est_abonne,statut,date_demande").in("session_id", sessionIds).order("date_demande", { ascending: true }),
        supabaseAdmin.from("sessions").select("id,nom,debut_date,horaires,statut").in("id", sessionIds),
      ]);
      if (eventsError) throw eventsError;
      if (votesError) throw votesError;
      if (sessionsError) throw sessionsError;

      const actifs = activeVotes || [];
      const actifsParId = new Set(actifs.map(vote => String(vote.id)));
      const sessionParId = new Map((sessions || []).map(session => [session.id, session]));
      const lignes = [...(events || [])].map(event => ({ ...event, actif: event.type_evenement === "vote" && actifsParId.has(String(event.inscription_id)), ancien_enregistrement: false }));
      const votesJournalises = new Set(lignes.filter(event => event.type_evenement === "vote").map(event => String(event.inscription_id)));
      for (const vote of actifs) {
        if (votesJournalises.has(String(vote.id))) continue;
        const session = sessionParId.get(vote.session_id);
        lignes.push({ inscription_id: vote.id, session_id: vote.session_id, session_nom: session?.nom || null, session_debut_date: session?.debut_date || null, session_horaires: session?.horaires || null, prenom: vote.prenom, nom: vote.nom, est_invite: vote.est_invite === true, invite_par_nom: vote.invite_par_nom || null, est_abonne: vote.est_abonne === true, type_evenement: "vote", statut: vote.statut, date_demande: vote.date_demande, created_at: null, acteur: vote.est_invite ? (vote.invite_par_nom || null) : `${vote.prenom} ${vote.nom}`, actif: true, ancien_enregistrement: true });
      }
      return reponseJson({ authorized: true, activeCount: actifs.length, activeVotes: actifs, events: lignes, sessions: sessions || [], generatedAt: new Date().toISOString() }, 200);
    }
    if (action === "set_session_status") {
      const sessionId = body?.sessionId;
      const statut = body?.statut;

      if (!["session-mardi", "session-jeudi"].includes(sessionId)) {
        return reponseJson({ error: "Identifiant de session invalide." }, 400);
      }

      if (!["ouvert", "annulee"].includes(statut)) {
        return reponseJson({ error: "Statut de session invalide." }, 400);
      }

      const { data, error } = await supabaseAdmin
        .from("sessions")
        .update({ statut })
        .eq("id", sessionId)
        .select("id, statut")
        .single();

      if (error) {
        console.error("Erreur mise à jour statut session :", error);
        return reponseJson({ error: error.message }, 400);
      }

      return reponseJson({ authorized: true, session: data }, 200);
    }

    if (action === "update_session") {
      const sessionId = body?.sessionId;
      const debutDate = body?.debut_date;
      const horaires = body?.horaires;
      const nom = body?.nom;

      if (!["session-mardi", "session-jeudi"].includes(sessionId)) {
        return reponseJson({ error: "Identifiant de session invalide." }, 400);
      }

      if (
        typeof debutDate !== "string" ||
        isNaN(Date.parse(debutDate)) ||
        typeof horaires !== "string" ||
        typeof nom !== "string"
      ) {
        return reponseJson({ error: "Date ou horaires invalides." }, 400);
      }

      const { data, error } = await supabaseAdmin
        .from("sessions")
        .update({
          debut_date: debutDate,
          horaires,
          nom,
        })
        .eq("id", sessionId)
        .select("id, nom, debut_date, horaires, statut")
        .single();

      if (error) {
        console.error("Erreur modification session :", error);
        return reponseJson({ error: error.message }, 400);
      }

      return reponseJson({ authorized: true, session: data }, 200);
    }

    return reponseJson({ error: "Action inconnue." }, 400);
  } catch (error) {
    console.error("Erreur admin-actions :", error);
    return reponseJson({ error: "Requête invalide ou erreur interne." }, 500);
  }
});