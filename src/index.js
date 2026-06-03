/**
 * Webhook systeme.io → Abby
 * Regroupe offre principale + order bump + upsell en une seule facture Abby (brouillon).
 *
 * Architecture Cloudflare :
 *  - KV (ORDERS)  : stockage temporaire des commandes en attente
 *  - Queue        : déclenche le traitement après DELAY_SECONDS
 *
 * Logique client :
 *  1. Pro français  → recherche SIRET via TVA FR, adresse via data.gouv.fr
 *  2. Pro étranger  → pays fourni par systeme.io, mention TVA selon zone (UE / hors-UE)
 *  3. Particulier   → création contact simple (pas de numéro de TVA)
 */

const ABBY_BASE_URL = "https://api.app-abby.com";

// ─── LISTE DES PAYS DE L'UE (codes ISO-3166-1 alpha-2) ───────────────────────

const EU_COUNTRIES = new Set([
  "AT","BE","BG","CY","CZ","DE","DK","EE","ES","FI",
  "FR","GR","HR","HU","IE","IT","LT","LU","LV","MT",
  "NL","PL","PT","RO","SE","SI","SK",
]);

/**
 * Détermine la zone fiscale d'un pays.
 * @param {string} countryCode  Code ISO-2 (ex : "BE", "CH", "US")
 * @returns {"FR"|"EU"|"WORLD"}
 */
function getTaxZone(countryCode) {
  const code = (countryCode || "FR").toUpperCase().slice(0, 2);
  if (code === "FR") return "FR";
  if (EU_COUNTRIES.has(code)) return "EU";
  return "WORLD";
}

/**
 * Retourne le vatCode Abby et la mention légale à ajouter aux lignes
 * en fonction de la zone fiscale.
 *
 * - FR      → TVA normale 20 % (FR_20)
 * - EU      → autoliquidation, Art. 44 directive 2006/112/CE  (FR_00HT)
 * - WORLD   → exonération TVA, Art. 262 CGI                   (FR_00HT)
 */
function getVatConfig(taxZone) {
  switch (taxZone) {
    case "FR":
      return {
        vatCode: "FR_20",
        mention: null,          // TVA normale, pas de mention spéciale
      };
    case "EU":
      return {
        vatCode: "FR_00HT",
        mention: "Autoliquidation - Article 44 de la directive 2006/112/CE",
      };
    case "WORLD":
    default:
      return {
        vatCode: "FR_00HT",
        mention: "Exonération de TVA, article 262 du CGI",
      };
  }
}

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

// ─── API SIRET (data.gouv.fr) — uniquement pour TVA française ────────────────

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

    const siege       = results[0]?.siege || {};
    const siret       = siege.siret || null;
    const codePostal  = siege.code_postal || null;
    const ville       = siege.libelle_commune || null;
    const numVoie     = siege.numero_voie || "";
    const typeVoie    = siege.type_voie || "";
    const libelleVoie = siege.libelle_voie || "";
    const adresse     = [numVoie, typeVoie, libelleVoie].filter(Boolean).join(" ").trim()
                        || siege.geo_adresse || null;

    log("INFO", `SIRET: ${siret} | Adresse: ${adresse} | CP: ${codePostal} | Ville: ${ville}`);
    return { siret, adresse, codePostal, ville };
  } catch (e) {
    log("ERROR", `Erreur API data.gouv pour SIREN ${siren} :`, e.message);
    return null;
  }
}

// ─── LOGIQUE ABBY — recherche client ─────────────────────────────────────────

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

// ─── CRÉATION ORGANISATION ────────────────────────────────────────────────────
//
// Cas 1 — Pro français  (taxZone === "FR")
//   → récupère SIRET + adresse via data.gouv.fr à partir du numéro de TVA
//
// Cas 2 — Pro étranger  (taxZone === "EU" | "WORLD")
//   → utilise l'adresse fournie par systeme.io + vatNumber étranger
//   → le pays est déjà dans customer.country (extrait du payload systeme.io)

async function createOrganization(apiKey, customer) {
  const fields  = customer.fields || {};
  const company = fields.company_name ||
    `${fields.first_name || ""} ${fields.surname || ""}`.trim();
  const email      = customer.email || "";
  const vatNumber  = fields.tax_number || "";

  // Pays : fourni directement par systeme.io (champ racine ou dans fields)
  // systeme.io expose le pays dans customer.country (code ISO-2) ou fields.country
  const rawCountry = customer.country || fields.country || "FR";
  const country    = rawCountry.toUpperCase().slice(0, 2);
  const taxZone    = getTaxZone(country);

  log("INFO", `Pays détecté : ${country} → zone fiscale : ${taxZone}`);

  let siret   = null;
  let adresse = fields.address || "";
  let ville   = fields.city    || "";
  let cp      = fields.zip_code || fields.zipcode || "";

  if (taxZone === "FR") {
    // Pro français → enrichissement via data.gouv.fr
    const infos = await getSiretFromVat(vatNumber);
    siret   = infos?.siret      || null;
    adresse = infos?.adresse    || adresse;
    ville   = infos?.ville      || ville;
    cp      = infos?.codePostal || cp;
  }
  // Pro étranger → on utilise directement les champs systeme.io (déjà assignés ci-dessus)

  const body = {
    name:      company,
    emails:    email ? [email] : [],
    vatNumber: vatNumber,
  };
  if (siret) body.siret = siret;

  if (adresse && ville && cp) {
    body.billingAddress = {
      address: adresse,
      city:    ville,
      zipCode: cp,
      country: country,
    };
    log("INFO", `Adresse envoyée : ${adresse}, ${cp} ${ville} (${country})`);
  } else {
    log("INFO", `Adresse incomplète — adresse=${adresse} ville=${ville} cp=${cp}`);
  }

  log("INFO", `Création organisation : ${company} (SIRET: ${siret || "N/A"}, zone: ${taxZone})`);
  const result = await abbyPost(apiKey, "/organization", body);
  log("INFO", "Réponse Abby organisation : " + JSON.stringify(result));

  // On retourne aussi la taxZone pour qu'elle soit disponible lors de la facturation
  return result ? { ...result, _taxZone: taxZone } : null;
}

// ─── TROUVER OU CRÉER UN CLIENT ───────────────────────────────────────────────
//
// Retourne { customerId, taxZone }

async function getOrCreateCustomer(apiKey, customer) {
  const email = customer.email || "";

  // Pays du client (disponible dans le payload systeme.io)
  const rawCountry = customer.country || customer.fields?.country || "FR";
  const country    = rawCountry.toUpperCase().slice(0, 2);
  const taxZone    = getTaxZone(country);

  // 1. Organisation existante ?
  const org = await findOrganizationByEmail(apiKey, email);
  if (org) {
    log("INFO", `Organisation trouvée : ${org.name} (id=${org.id})`);
    return { customerId: org.id, taxZone };
  }

  // 2. Contact existant ?
  const contact = await findContactByEmail(apiKey, email);
  if (contact) {
    log("INFO", `Contact trouvé : ${contact.fullname || ""} (id=${contact.id})`);
    return { customerId: contact.id, taxZone };
  }

  // 3. Création selon le type de client
  const fields  = customer.fields || {};
  const company = fields.company_name || "";

  if (company) {
    // Pro (français ou étranger) → organisation
    const newOrg = await createOrganization(apiKey, customer);
    if (newOrg) {
      log("INFO", `Organisation créée : id=${newOrg.id}`);
      return { customerId: newOrg.id, taxZone: newOrg._taxZone || taxZone };
    }
  } else {
    // Particulier → contact simple
    const first = fields.first_name || "";
    const last  = fields.surname || fields.last_name || "";
    const newContact = await abbyPost(apiKey, "/contact", {
      firstname: first || "Client",
      lastname:  last  || first || "Client",
      emails:    email ? [email] : [],
    });
    if (newContact) {
      log("INFO", `Contact créé : id=${newContact.id}`);
      // Particuliers : toujours traités comme résidents FR pour la TVA
      return { customerId: newContact.id, taxZone: "FR" };
    }
  }

  return { customerId: null, taxZone };
}

// ─── CRÉATION FACTURE AVEC LIGNES ─────────────────────────────────────────────
//
// La mention légale TVA est ajoutée en tant que ligne de type "comment"
// si la zone n'est pas FR.

async function createInvoiceWithLines(apiKey, customerId, items, taxZone) {
  log("INFO", `Création facture brouillon pour customerId=${customerId} (zone: ${taxZone})…`);

  const { vatCode, mention } = getVatConfig(taxZone);

  // La mention légale TVA va dans le champ "notes" de la facture (pas dans les lignes)
  // car l'API Abby n'accepte pas de type "comment" sur les lignes.
  const invoiceBody = {};
  if (mention) {
    invoiceBody.notes = mention;
    log("INFO", `Mention TVA injectée dans notes : "${mention}"`);
  }

  const invoice = await abbyPost(apiKey, `/v2/billing/invoice/${customerId}`, invoiceBody);
  if (!invoice) return null;

  const billingId = invoice.id;
  log("INFO", `Facture créée : id=${billingId} — construction des lignes…`);

  // Lignes produits uniquement (types valides Abby)
  const lines = items.map((item) => ({
    designation:       item.name,
    quantity:          1,
    quantityUnit:      "unit",
    unitPrice:         Math.round(item.unit_price_eur * 100),
    type:              "service_delivery",
    vatCode:           vatCode,
    isDeliveryOfGoods: false,
  }));

  log("INFO", `Ajout de ${lines.length} ligne(s) à la facture id=${billingId}…`);
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

  const { customerId, taxZone } = await getOrCreateCustomer(env.ABBY_API_KEY, customer);
  if (!customerId) {
    log("ERROR", "Impossible de trouver/créer le client — abandon.");
    return;
  }

  const invoice = await createInvoiceWithLines(env.ABBY_API_KEY, customerId, items, taxZone);
  if (invoice) log("INFO", `✅ Facture brouillon finalisée : id=${invoice.id}`);
  else log("ERROR", "❌ Échec création facture.");
}

// ─── PARSING WEBHOOK ──────────────────────────────────────────────────────────

function parseWebhook(payload) {
  try {
    const data     = payload.data || {};
    const orderId  = String(data.order.id);
    const customer = data.customer;

    // systeme.io expose le pays dans data.customer.country (code ISO-2)
    // On s'assure qu'il est bien disponible sur l'objet customer
    if (!customer.country && data.customer?.billing_address?.country) {
      customer.country = data.customer.billing_address.country;
    }

    const offer      = data.offer_price_plan || data.price_plan || {};
    const name       = offer.name || "Produit";
    const amountCents = offer.direct_charge_amount || offer.amount || 0;
    let unitPrice    = Math.round(amountCents) / 100;

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

      await env.ORDER_QUEUE.send({ orderId }, { delaySeconds });
    }

    await env.ORDERS.put(orderId, JSON.stringify(orderData), {
      expirationTtl: delaySeconds + 300,
    });

    return new Response("OK");
  },

  async queue(batch, env) {
    for (const msg of batch.messages) {
      const { orderId } = msg.body;
      await processOrder(orderId, env);
      msg.ack();
    }
  },
};
