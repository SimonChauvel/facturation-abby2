/**
 * Webhook systeme.io → Abby
 * Regroupe offre principale + order bump + upsell en une seule facture Abby (brouillon).
 *
 * Architecture Cloudflare :
 *  - KV (ORDERS)  : stockage temporaire des commandes en attente
 *  - Queue        : déclenche le traitement après DELAY_SECONDS
 */

const ABBY_BASE_URL = "https://api.app-abby.com";

// ─── HELPERS LOGS ─────────────────────────────────────────────────────────────

function log(level, ...args) {
  const ts = new Date().toISOString();
  const msg = args.join(" ");
  if (level === "ERROR") console.error(`${ts} [${level}] ${msg}`);
  else console.log(`${ts} [${level}] ${msg}`);
}

// ─── HELPERS API ABBY ─────────────────────────────────────────────────────────

function abbyHeaders(apiKey) {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

async function abbyGet(apiKey, path, params = {}) {
  const url = new URL(`${ABBY_BASE_URL}${path}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const r = await fetch(url.toString(), { headers: abbyHeaders(apiKey) });
  if (r.ok) return r.json();
  const txt = await r.text();
  log("ERROR", `GET ${path} → ${r.status}`, txt.slice(0, 300));
  return null;
}

async function abbyPost(apiKey, path, body) {
  const r = await fetch(`${ABBY_BASE_URL}${path}`, {
    method: "POST",
    headers: abbyHeaders(apiKey),
    body: JSON.stringify(body),
  });
  if (r.ok) return r.json();
  const txt = await r.text();
  log("ERROR", `POST ${path} → ${r.status}`, txt.slice(0, 300));
  return null;
}

async function abbyPatch(apiKey, path, body) {
  const r = await fetch(`${ABBY_BASE_URL}${path}`, {
    method: "PATCH",
    headers: abbyHeaders(apiKey),
    body: JSON.stringify(body),
  });
  if (r.ok) return r.json();
  const txt = await r.text();
  log("ERROR", `PATCH ${path} → ${r.status}`, txt.slice(0, 300));
  return null;
}

// ─── API SIRET (data.gouv.fr) ─────────────────────────────────────────────────
async function getSiretFromVat(vatNumber) {
  if (!vatNumber) return null;
  const vat = vatNumber.trim().toUpperCase();
  if (!vat.startsWith("FR") || vat.length < 13) {
    log("INFO", `Numéro de TVA non FR ou trop court (${vatNumber}) — SIRET ignoré`);
    return null;
  }

  const siren = vat.slice(4);

  try {
    const r = await fetch(
      `https://recherche-entreprises.api.gouv.fr/search?q=${siren}&page=1&per_page=1`
    );
    if (!r.ok) {
      log("ERROR", `data.gouv SIREN ${siren} → ${r.status}`);
      return null;
    }
    const data = await r.json();
    const results = data.results || [];
    if (!results.length) return null;

    const siege = results[0]?.siege || {};
    const siret      = siege.siret || null;
    const codePostal = siege.code_postal || null;
    const ville      = siege.libelle_commune || null;

    // Reconstruction de la ligne d'adresse depuis les champs détaillés
    const numVoie    = siege.numero_voie || "";
    const typeVoie   = siege.type_voie || "";
    const libelleVoie = siege.libelle_voie || "";
    const adresse    = [numVoie, typeVoie, libelleVoie].filter(Boolean).join(" ").trim()
                       || siege.geo_adresse || null;

    log("INFO", `SIRET: ${siret} | Adresse: ${adresse} | CP: ${codePostal} | Ville: ${ville}`);

    return { siret, adresse, codePostal, ville };
  } catch (e) {
    log("ERROR", `Erreur API data.gouv pour SIREN ${siren} :`, e.message);
    return null;
  }
}

// ─── LOGIQUE ABBY ─────────────────────────────────────────────────────────────

async function findContactByEmail(apiKey, email) {
  const result = await abbyGet(apiKey, "/contacts", { search: email, page: 1, limit: 50 });
  if (!result) return null;
  for (const c of result.docs || []) {
    const emails = c.emails || [];
    if (Array.isArray(emails)) {
      if (emails.some((e) => e.toLowerCase() === email.toLowerCase())) return c;
    } else if (emails.toLowerCase() === email.toLowerCase()) return c;
  }
  return null;
}

async function findOrganizationByEmail(apiKey, email) {
  const result = await abbyGet(apiKey, "/organizations", { search: email, page: 1, limit: 50 });
  if (!result) return null;
  for (const org of result.docs || []) {
    const emails = org.emails || [];
    if (Array.isArray(emails)) {
      if (emails.some((e) => e.toLowerCase() === email.toLowerCase())) return org;
    } else if (emails.toLowerCase() === email.toLowerCase()) return org;
  }
  return null;
}

async function createOrganization(apiKey, customer) {
  const fields  = customer.fields || {};
  const company = fields.company_name ||
    `${fields.first_name || ""} ${fields.surname || ""}`.trim();
  const email      = customer.email || "";
  const vatNumber  = fields.tax_number || "";

  const infos  = await getSiretFromVat(vatNumber);
  const siret  = infos?.siret || null;
  const adresse = infos?.adresse || fields.address || "";
  const ville   = infos?.ville   || fields.city    || "";
  const cp      = infos?.codePostal || fields.zip_code || fields.zipcode || "";
  const country = (fields.country || "FR").toUpperCase().slice(0, 2);

  const body = {
    name:       company,
    emails:     email ? [email] : [],
    vatNumber:  vatNumber,
  };
  if (siret) body.siret = siret;

  if (adresse && ville && cp) {
    body.billingAddress = {
      address: adresse,
      city:    ville,
      zipCode: cp,
      country: country,
    };
    log("INFO", `Adresse envoyée : ${adresse}, ${cp} ${ville}`);
  } else {
    log("INFO", `Adresse incomplète — adresse=${adresse} ville=${ville} cp=${cp}`);
  }

  log("INFO", `Création organisation : ${company} (SIRET: ${siret || "non disponible"})`);
  const result = await abbyPost(apiKey, "/organization", body);
  log("INFO", "Réponse Abby : " + JSON.stringify(result));
  return result;
}

async function getOrCreateCustomerId(apiKey, customer) {
  const email = customer.email || "";

  const org = await findOrganizationByEmail(apiKey, email);
  if (org) {
    log("INFO", `Organisation trouvée : ${org.name} (id=${org.id})`);
    return org.id;
  }

  const contact = await findContactByEmail(apiKey, email);
  if (contact) {
    log("INFO", `Contact trouvé : ${contact.fullname || ""} (id=${contact.id})`);
    return contact.id;
  }

  const fields = customer.fields || {};
  const company = fields.company_name || "";

  if (company) {
    const newOrg = await createOrganization(apiKey, customer);
    if (newOrg) {
      log("INFO", `Organisation créée : id=${newOrg.id}`);
      return newOrg.id;
    }
  } else {
    const first = fields.first_name || "";
    const last = fields.surname || fields.last_name || "";
    const newContact = await abbyPost(apiKey, "/contact", {
      firstname: first || "Client",
      lastname: last || first || "Client",
      emails: email ? [email] : [],
    });
    if (newContact) {
      log("INFO", `Contact créé : id=${newContact.id}`);
      return newContact.id;
    }
  }

  return null;
}

async function createInvoiceWithLines(apiKey, customerId, items) {
  log("INFO", `Création facture brouillon pour customerId=${customerId}…`);
  const invoice = await abbyPost(apiKey, `/v2/billing/invoice/${customerId}`, {});
  if (!invoice) return null;

  const billingId = invoice.id;
  log("INFO", `Facture créée : id=${billingId} — ajout de ${items.length} ligne(s)…`);

  const lines = items.map((item) => ({
    designation: item.name,
    quantity: 1,
    quantityUnit: "unit",
    unitPrice: Math.round(item.unit_price_eur * 100),
    type: "sale_of_goods",
    vatCode: "FR_00HT",
    isDeliveryOfGoods: false,
  }));

  const updated = await abbyPatch(apiKey, `/v2/billing/${billingId}/lines`, { lines });
  if (updated) log("INFO", `✅ Lignes ajoutées à la facture id=${billingId}`);
  else log("ERROR", `❌ Échec ajout des lignes (facture id=${billingId} créée mais vide)`);

  return updated || invoice;
}

// ─── TRAITEMENT COMMANDE (appelé par la Queue) ────────────────────────────────

async function processOrder(orderId, env) {
  const raw = await env.ORDERS.get(orderId);
  if (!raw) {
    log("WARN", `Commande ${orderId} introuvable en KV (déjà traitée ?)`);
    return;
  }

  await env.ORDERS.delete(orderId);
  const orderData = JSON.parse(raw);
  const { customer, items } = orderData;

  log("INFO", `=== Traitement commande ${orderId} — ${items.length} produit(s) ===`);
  items.forEach((it) => log("INFO", `  • ${it.name} (${it.unit_price_eur.toFixed(2)} €)`));

  const customerId = await getOrCreateCustomerId(env.ABBY_API_KEY, customer);
  if (!customerId) {
    log("ERROR", "Impossible de trouver/créer le client — abandon.");
    return;
  }

  const invoice = await createInvoiceWithLines(env.ABBY_API_KEY, customerId, items);
  if (invoice) log("INFO", `✅ Facture brouillon finalisée : id=${invoice.id}`);
  else log("ERROR", "❌ Échec création facture.");
}

// ─── PARSING WEBHOOK ──────────────────────────────────────────────────────────

function parseWebhook(payload) {
  try {
    const data = payload.data || {};
    const orderId = String(data.order.id);
    const customer = data.customer;

    const offer = data.offer_price_plan || data.price_plan || {};
    const name = offer.name || "Produit";
    const amountCents = offer.direct_charge_amount || offer.amount || 0;
    let unitPrice = Math.round(amountCents) / 100;

    const total = data.order?.total_price;
    if (total !== undefined && total !== null && total === 0) unitPrice = 0.0;

    return { orderId, customer, item: { name, unit_price_eur: unitPrice } };
  } catch (e) {
    log("ERROR", "Erreur parsing webhook :", e.message);
    return null;
  }
}

// ─── HANDLER PRINCIPAL ────────────────────────────────────────────────────────

export default {
  // Reçoit les requêtes HTTP (webhooks systeme.io)
  async fetch(request, env) {
    if (request.method === "GET") {
      return new Response("Serveur webhook systeme.io → Abby actif ✓", {
        headers: { "Content-Type": "text/plain;charset=utf-8" },
      });
    }

    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    let payload;
    try {
      payload = await request.json();
    } catch {
      log("ERROR", "Payload JSON invalide");
      return new Response("Bad Request", { status: 400 });
    }

    const result = parseWebhook(payload);
    if (!result) return new Response("OK");

    const { orderId, customer, item } = result;
    const delaySeconds = parseInt(env.DELAY_SECONDS || "60");

    // Charge l'ordre existant depuis KV ou en crée un nouveau
    const existing = await env.ORDERS.get(orderId);
    let orderData;

    if (existing) {
      orderData = JSON.parse(existing);
      orderData.items.push(item);
      log("INFO", `Produit ajouté à ${orderId} : ${item.name} (${item.unit_price_eur.toFixed(2)} €)`);
    } else {
      orderData = { customer, items: [item] };
      log("INFO", `Nouvelle commande : ${orderId} — timer ${delaySeconds}s`);
      log("INFO", `Produit ajouté à ${orderId} : ${item.name} (${item.unit_price_eur.toFixed(2)} €)`);

      // Envoie le message dans la Queue avec un délai
      await env.ORDER_QUEUE.send(
        { orderId },
        { delaySeconds }
      );
    }

    // Sauvegarde l'état dans KV (TTL = délai + 5 min de marge)
    await env.ORDERS.put(orderId, JSON.stringify(orderData), {
      expirationTtl: delaySeconds + 300,
    });

    return new Response("OK");
  },

  // Consomme les messages de la Queue (traitement après délai)
  async queue(batch, env) {
    for (const msg of batch.messages) {
      const { orderId } = msg.body;
      await processOrder(orderId, env);
      msg.ack();
    }
  },
};
