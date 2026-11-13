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


async function demanderJetonHelloAsso(clientId: string, clientSecret: string, refreshToken?: string) {
  const formulaire = new URLSearchParams();
  if (refreshToken) {
    formulaire.set("grant_type", "refresh_token");
    formulaire.set("refresh_token", refreshToken);
  } else {
    formulaire.set("grant_type", "client_credentials");
    formulaire.set("client_id", clientId);
    formulaire.set("client_secret", clientSecret);
  }

  const response = await fetch("https://api.helloasso.com/oauth2/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Accept": "application/json",
      "User-Agent": "BasketBLR-Reservations/1.0",
    },
    body: formulaire.toString(),
  });
  const corps = await response.text().catch(() => "");
  let resultat: Record<string, unknown> = {};
  try { resultat = JSON.parse(corps); } catch {}
  if (!response.ok || typeof resultat.access_token !== "string" || typeof resultat.refresh_token !== "string") {
    const code = typeof resultat.error === "string" ? resultat.error : "";
      const message = typeof resultat.message === "string" ? resultat.message.replace(/[\r\n\t]/g, " ").slice(0, 140) : "";
    const contentType = response.headers.get("content-type") || "type de réponse inconnu";
    const titreHtml = corps.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 100) || "";
    console.error("Refus OAuth HelloAsso", JSON.stringify({
      status: response.status,
      contentType,
      server: response.headers.get("server"),
      cfRay: response.headers.get("cf-ray"),
      htmlTitle: titreHtml || null,
    }));
    const detail = code || message || (titreHtml ? contentType + ", " + titreHtml : contentType);
    throw new Error("Authentification HelloAsso refusée (HTTP " + response.status + ", " + detail + "). Vérifie la clé API HelloAsso et les droits de l’association.");
  }
  return resultat;
}

async function obtenirJetonHelloAsso(supabaseAdmin: ReturnType<typeof createClient>) {
  const clientId = Deno.env.get("HELLOASSO_CLIENT_ID")?.trim();
  const clientSecret = Deno.env.get("HELLOASSO_CLIENT_SECRET")?.trim();
  if (!clientId || !clientSecret) {
    throw new Error("Les secrets HELLOASSO_CLIENT_ID et HELLOASSO_CLIENT_SECRET sont requis dans Supabase.");
  }

  const { data: etat, error: lectureErreur } = await supabaseAdmin
    .from("helloasso_oauth_state")
    .select("access_token,refresh_token,access_token_expires_at")
    .eq("id", "main")
    .maybeSingle();
  if (lectureErreur) throw new Error("Impossible de lire l’état OAuth HelloAsso.");
  const expiration = etat?.access_token_expires_at ? Date.parse(etat.access_token_expires_at) : 0;
  if (etat?.access_token && expiration > Date.now() + 120000) return etat.access_token;

  let jeton;
  if (etat?.refresh_token) {
    const form = new URLSearchParams();
    form.set("grant_type", "refresh_token");
    form.set("refresh_token", etat.refresh_token);
    let response = await fetch("https://api.helloasso.com/oauth2/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "application/json",
        "User-Agent": "BasketBLR-Reservations/1.0",
      },
      body: form.toString(),
    });
    let resultat = await response.json().catch(() => ({}));
    if ((!response.ok || typeof resultat.access_token !== "string") && (response.status === 400 || response.status === 401)) {
      jeton = await demanderJetonHelloAsso(clientId, clientSecret);
    } else {
      if (!response.ok || typeof resultat.access_token !== "string" || typeof resultat.refresh_token !== "string") {
        throw new Error("Renouvellement du jeton HelloAsso impossible (HTTP " + response.status + ").");
      }
      jeton = resultat;
    }
  } else {
    jeton = await demanderJetonHelloAsso(clientId, clientSecret);
  }

  const expiresIn = Math.max(60, Number(jeton.expires_in) || 1799);
  const { error: sauvegardeErreur } = await supabaseAdmin
    .from("helloasso_oauth_state")
    .upsert({
      id: "main",
      access_token: jeton.access_token,
      refresh_token: jeton.refresh_token,
      access_token_expires_at: new Date(Date.now() + expiresIn * 1000).toISOString(),
      updated_at: new Date().toISOString(),
    }, { onConflict: "id" });
  if (sauvegardeErreur) throw new Error("Impossible d’enregistrer le renouvellement sécurisé du jeton HelloAsso.");
  return jeton.access_token as string;
}

async function chargerAdherentsHelloAsso(supabaseAdmin: ReturnType<typeof createClient>) {
  const jeton = await obtenirJetonHelloAsso(supabaseAdmin);
  const organisation = "basket-loisir-reunion";
  const formulaire = "adhesion-blr-jusqu-a-fin-juillet-27";
  const membres = new Map<string, { prenom: string; nom: string }>();
  const pageSize = 100;

  for (let pageIndex = 1; pageIndex <= 100; pageIndex++) {
    const url = "https://api.helloasso.com/v5/organizations/" + encodeURIComponent(organisation) +
      "/forms/Membership/" + encodeURIComponent(formulaire) + "/orders?pageIndex=" + pageIndex +
      "&pageSize=" + pageSize + "&withDetails=true&sortOrder=Asc";
    const response = await fetch(url, {
      headers: {
        Authorization: "Bearer " + jeton,
        Accept: "application/json",
        "User-Agent": "BasketBLR-Reservations/1.0",
      },
    });
    const corpsReponse = await response.text().catch(() => "");
    let resultat: Record<string, unknown> = {};
    try { resultat = JSON.parse(corpsReponse); } catch {}
    if (!response.ok) {
      const message = typeof resultat.message === "string" ? resultat.message.replace(/[\r\n\t]/g, " ").slice(0, 140) : "";
      const erreur = typeof resultat.error === "string" ? resultat.error : "";
      const contentType = response.headers.get("content-type") || "type de réponse inconnu";
      const titreHtml = corpsReponse.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 100) || "";
      console.error("Accès HelloAsso aux adhésions refusé", JSON.stringify({
        status: response.status,
        contentType,
        server: response.headers.get("server"),
        cfRay: response.headers.get("cf-ray"),
        message: message || erreur || null,
        htmlTitle: titreHtml || null,
      }));
      const detail = message || erreur || (titreHtml ? contentType + ", " + titreHtml : contentType);
      throw new Error("Accès à la liste des adhésions HelloAsso refusé (HTTP " + response.status + (detail ? ", " + detail : "") + ").");
    }

    const commandes = Array.isArray(resultat.data) ? resultat.data : [];
    for (const commande of commandes) {
      const items = Array.isArray(commande.items) ? commande.items : [];
      const paiementsCommande = Array.isArray(commande.payments) ? commande.payments : [];
      for (let index = 0; index < items.length; index++) {
        const item = items[index] || {};
        const type = String(item.type || "").toLowerCase();
        if (type && type !== "membership") continue;

        const paiementsItem = Array.isArray(item.payments) ? item.payments : [];
        const paiements = [...paiementsCommande, ...paiementsItem];
        const etatsPaiement = paiements.map((p: any) => String(p?.state || "").toLowerCase()).filter(Boolean);
        const etatItem = String(item.state || "").toLowerCase();
        const etatCommande = String(commande.state || "").toLowerCase();
        const etatsValides = ["authorized", "registered"];
        const etatsRefuses = ["refused", "refunded", "refunding", "contested", "canceled", "cancelled", "deleted", "abandoned"];
        const paiementConfirme = etatsPaiement.some((state: string) => etatsValides.includes(state))
          && !etatsPaiement.some((state: string) => etatsRefuses.includes(state));
        const itemConfirme = ["processed", "registered"].includes(etatItem);
        const commandeConfirmee = ["processed", "registered"].includes(etatCommande);
        const paiementVerifiable = etatsPaiement.length > 0;
        if (paiementVerifiable ? !paiementConfirme : !(itemConfirme || commandeConfirmee)) continue;

        const utilisateur = item.user || item.beneficiary || {};
        const payeur = commande.payer || {};
        const prenom = String(utilisateur.firstName || item.firstName || payeur.firstName || "").trim();
        const nom = String(utilisateur.lastName || item.lastName || payeur.lastName || "").trim();
        if (!prenom && !nom) continue;

        const identifiant = String(item.id || (String(commande.id || "order") + "-" + index));
        membres.set(identifiant, { prenom, nom });
      }
    }
    if (commandes.length < pageSize) break;
  }

  const liste = [...membres.values()].sort((a, b) =>
    a.nom.localeCompare(b.nom, "fr", { sensitivity: "base" }) ||
    a.prenom.localeCompare(b.prenom, "fr", { sensitivity: "base" })
  );
  return liste;
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

    if (action === "get_helloasso_members") {
      try {
        const membres = await chargerAdherentsHelloAsso(supabaseAdmin);
        return reponseJson({ authorized: true, members: membres, count: membres.length }, 200);
      } catch (error) {
        console.error("Erreur de récupération de la liste HelloAsso :", error instanceof Error ? error.message : "erreur inconnue");
        return reponseJson({ error: error instanceof Error ? error.message : "Impossible de récupérer la liste HelloAsso." }, 502);
      }
    }

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
      const maintenant = new Date();
      const partsDate = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
        timeZone: "Indian/Reunion", year: "numeric", month: "2-digit"
      }).formatToParts(maintenant).map(part => [part.type, part.value]));
      const annee = Number(partsDate.year);
      const anneeSaison = Number(partsDate.month) >= 8 ? annee : annee - 1;
      const season = `${anneeSaison}-${anneeSaison + 1}`;
      const dateLancement = "2026-11-08T14:00:00.000Z";
      const [
        { data: events, error: eventsError },
        { data: activeVotes, error: votesError },
        { data: sessions, error: sessionsError },
        { data: seasonPlayerStats, error: playerStatsError },
        { data: seasonSessionStats, error: sessionStatsError },
      ] = await Promise.all([
        supabaseAdmin.from("inscription_evenements").select("*").in("session_id", sessionIds).order("created_at", { ascending: true }),
        supabaseAdmin.from("inscriptions").select("id,session_id,prenom,nom,est_invite,invite_par_nom,est_abonne,statut,date_demande").in("session_id", sessionIds).order("date_demande", { ascending: true }),
        supabaseAdmin.from("sessions").select("id,nom,debut_date,horaires,statut").in("id", sessionIds),
        supabaseAdmin.from("statistiques_saison_joueurs").select("*").eq("saison", season).gte("capture_le", dateLancement).order("semaine_debut", { ascending: true }).order("nom", { ascending: true }).order("prenom", { ascending: true }),
        supabaseAdmin.from("statistiques_saison_creneaux").select("*").eq("saison", season).gte("capture_le", dateLancement).order("semaine_debut", { ascending: true }),
      ]);
      if (eventsError) throw eventsError;
      if (votesError) throw votesError;
      if (sessionsError) throw sessionsError;
      if (playerStatsError) throw playerStatsError;
      if (sessionStatsError) throw sessionStatsError;

      const actifs = activeVotes || [];
      const actifsParId = new Set(actifs.map(vote => String(vote.id)));
      const sessionParId = new Map((sessions || []).map(session => [session.id, session]));
      const lignes = [...(events || [])].map(event => ({
        ...event,
        actif: event.type_evenement === "vote" && actifsParId.has(String(event.inscription_id)),
        ancien_enregistrement: false,
      }));
      const votesJournalises = new Set(lignes.filter(event => event.type_evenement === "vote").map(event => String(event.inscription_id)));
      for (const vote of actifs) {
        if (votesJournalises.has(String(vote.id))) continue;
        const session = sessionParId.get(vote.session_id);
        lignes.push({
          inscription_id: vote.id,
          session_id: vote.session_id,
          session_nom: session?.nom || null,
          session_debut_date: session?.debut_date || null,
          session_horaires: session?.horaires || null,
          prenom: vote.prenom,
          nom: vote.nom,
          est_invite: vote.est_invite === true,
          invite_par_nom: vote.invite_par_nom || null,
          est_abonne: vote.est_abonne === true,
          type_evenement: "vote",
          statut: vote.statut,
          date_demande: vote.date_demande,
          created_at: null,
          acteur: vote.est_invite ? (vote.invite_par_nom || null) : `${vote.prenom} ${vote.nom}`,
          actif: true,
          ancien_enregistrement: true,
        });
      }
      return reponseJson({
        authorized: true,
        activeCount: actifs.length,
        activeVotes: actifs,
        events: lignes,
        sessions: sessions || [],
        season,
        seasonPlayerStats: seasonPlayerStats || [],
        seasonSessionStats: seasonSessionStats || [],
        generatedAt: new Date().toISOString(),
      }, 200);
    }
    if (action === "confirm_vote") {
      const voteId = String(body?.voteId || "");
      if (!voteId) return reponseJson({ error: "Vote introuvable." }, 400);

      const { data: vote, error: voteError } = await supabaseAdmin
        .from("inscriptions")
        .select("id,session_id,statut")
        .eq("id", voteId)
        .maybeSingle();
      if (voteError) throw voteError;
      if (!vote) return reponseJson({ error: "Vote introuvable ou déjà annulé." }, 404);
      if (vote.statut === "confirmed") return reponseJson({ authorized: true, alreadyConfirmed: true }, 200);
      if (vote.statut !== "waitlisted") return reponseJson({ error: "Seul un vote en attente peut être confirmé." }, 409);

      const { data: session, error: sessionError } = await supabaseAdmin
        .from("sessions")
        .select("debut_date,max_capacity,statut")
        .eq("id", vote.session_id)
        .maybeSingle();
      if (sessionError) throw sessionError;
      if (!session || session.statut === "annulee") return reponseJson({ error: "Créneau introuvable ou annulé." }, 409);
      if (new Date(session.debut_date).getTime() <= Date.now()) {
        return reponseJson({ error: "Ce créneau a déjà commencé." }, 409);
      }

      const { data: confirmes, error: confirmesError } = await supabaseAdmin
        .from("inscriptions")
        .select("id")
        .eq("session_id", vote.session_id)
        .eq("statut", "confirmed");
      if (confirmesError) throw confirmesError;
      const capacite = Number(session.max_capacity) || 22;
      if ((confirmes || []).length >= capacite) {
        return reponseJson({ error: "Le créneau est complet. Annule d’abord un vote confirmé pour libérer une place." }, 409);
      }

      const { data: voteConfirme, error: confirmationError } = await supabaseAdmin
        .from("inscriptions")
        .update({ admin_force_confirm: true, statut: "confirmed" })
        .eq("id", voteId)
        .eq("statut", "waitlisted")
        .select("id,statut")
        .maybeSingle();
      if (confirmationError) throw confirmationError;
      if (!voteConfirme) return reponseJson({ error: "Le vote a changé entre-temps. Actualise la liste et réessaie." }, 409);
      return reponseJson({ authorized: true, vote: voteConfirme }, 200);
    }

    if (action === "correct_vote_name") {
      const voteId = String(body?.voteId || "");
      const prenom = String(body?.prenom || "").trim().replace(/\s+/g, " ");
      const nom = String(body?.nom || "").trim().replace(/\s+/g, " ");
      if (!voteId || !prenom || !nom) {
        return reponseJson({ error: "Renseigne le prénom et le nom de famille en entier." }, 400);
      }
      const { data: correction, error: correctionError } = await supabaseAdmin.rpc(
        "admin_correct_inscription_name",
        { p_vote_id: voteId, p_prenom: prenom, p_nom: nom }
      );
      if (correctionError) {
        if (correctionError.code === "P0002") return reponseJson({ error: "Vote introuvable ou déjà remis à zéro." }, 404);
        if (correctionError.code === "23505") return reponseJson({ error: "Un joueur porte déjà ce prénom et ce nom sur ce créneau." }, 409);
        if (correctionError.code === "22023") return reponseJson({ error: "Le prénom et le nom sont obligatoires et limités à 100 caractères chacun." }, 400);
        throw correctionError;
      }
      return reponseJson({ authorized: true, correction }, 200);
    }

    if (action === "set_no_show") {
      const voteId = String(body?.voteId || "");
      const absent = body?.absent;
      if (!voteId || typeof absent !== "boolean") {
        return reponseJson({ error: "Vote ou action de signalement invalide." }, 400);
      }

      const { data: vote, error: voteError } = await supabaseAdmin
        .from("inscriptions")
        .select("id,session_id,prenom,nom,est_invite,invite_par_nom,est_abonne,statut,date_demande")
        .eq("id", voteId)
        .maybeSingle();
      if (voteError) throw voteError;
      if (!vote) return reponseJson({ error: "Vote introuvable ou déjà remis à zéro." }, 404);
      if (vote.statut !== "confirmed") {
        return reponseJson({ error: "Seul un joueur confirmé peut être signalé absent." }, 409);
      }

      const { data: session, error: sessionError } = await supabaseAdmin
        .from("sessions")
        .select("nom,debut_date,horaires,statut")
        .eq("id", vote.session_id)
        .maybeSingle();
      if (sessionError) throw sessionError;
      if (!session || session.statut === "annulee") {
        return reponseJson({ error: "Créneau introuvable ou annulé." }, 409);
      }

      const debutMs = new Date(session.debut_date).getTime();
      if (!Number.isFinite(debutMs)) return reponseJson({ error: "Date de créneau invalide." }, 400);
      const horaire = String(session.horaires || "").match(/(\d{1,2})h(\d{2})\s*-\s*(\d{1,2})h(\d{2})/i);
      let dureeMinutes = 150;
      if (horaire) {
        const debutMinutes = Number(horaire[1]) * 60 + Number(horaire[2]);
        const finMinutes = Number(horaire[3]) * 60 + Number(horaire[4]);
        dureeMinutes = (finMinutes - debutMinutes + 1440) % 1440 || 1440;
      }
      if (Date.now() < debutMs + dureeMinutes * 60000) {
        return reponseJson({ error: "Tu peux signaler une absence après l’heure de fin prévue du créneau." }, 409);
      }

      const { data: dernierSignalement, error: historiqueErreur } = await supabaseAdmin
        .from("inscription_evenements")
        .select("type_evenement")
        .eq("inscription_id", voteId)
        .in("type_evenement", ["absence", "annulation_absence"])
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (historiqueErreur) throw historiqueErreur;
      const absentActuellement = dernierSignalement?.type_evenement === "absence";
      if (absentActuellement === absent) {
        return reponseJson({ authorized: true, alreadySet: true, absent }, 200);
      }

      const { data: evenement, error: evenementErreur } = await supabaseAdmin
        .from("inscription_evenements")
        .insert({
          inscription_id: vote.id,
          session_id: vote.session_id,
          session_nom: session.nom || null,
          session_debut_date: session.debut_date,
          session_horaires: session.horaires || null,
          prenom: vote.prenom,
          nom: vote.nom,
          est_invite: vote.est_invite === true,
          invite_par_nom: vote.invite_par_nom || null,
          est_abonne: vote.est_abonne === true,
          type_evenement: absent ? "absence" : "annulation_absence",
          statut: vote.statut,
          date_demande: vote.date_demande || null,
          acteur: String(body?.acteur || "Administrateur").trim().slice(0, 160) || "Administrateur",
        })
        .select("id,type_evenement,created_at")
        .single();
      if (evenementErreur) throw evenementErreur;
      return reponseJson({ authorized: true, event: evenement, absent }, 200);
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