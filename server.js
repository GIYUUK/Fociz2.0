/* ===========================================================
   Fociz — serveur de comptes et de classement
   Node.js pur, aucune dépendance à installer.
   Les données sont dans /data/fociz.json
   =========================================================== */
const http = require('http');
const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT     = process.env.PORT || 8080;
const FICHIER  = process.env.DATA_FILE || '/data/fociz.json';
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const MAIL_FROM = process.env.MAIL_FROM || 'Fociz <onboarding@resend.dev>';
const FRONT_URL = process.env.FRONT_URL || '';   // ex: https://fociz.netlify.app

/* ---------- base de données (un simple fichier JSON) ---------- */
let base = { joueurs: {} };     // joueurs[cle] = {pseudo, sel, hash, tete, arbres, serie, minutes, amis[], jetons[]}

function charger(){
  try{
    base = JSON.parse(fs.readFileSync(FICHIER, 'utf8'));
    if(!base.joueurs) base.joueurs = {};
  }catch(e){
    base = { joueurs: {} };
  }
}
let enregistrementPrevu = false;
function enregistrer(){
  if(enregistrementPrevu) return;
  enregistrementPrevu = true;
  setTimeout(()=>{
    enregistrementPrevu = false;
    try{
      fs.mkdirSync(path.dirname(FICHIER), { recursive:true });
      fs.writeFileSync(FICHIER + '.tmp', JSON.stringify(base));
      fs.renameSync(FICHIER + '.tmp', FICHIER);
    }catch(e){ console.error('Sauvegarde impossible :', e.message); }
  }, 400);
}
charger();

/* ---------- envoi d'email (via Resend, aucune dépendance à installer) ---------- */
const emailValide = e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e||'').trim());

async function envoyerEmail(destinataire, sujet, html){
  if(!RESEND_API_KEY){
    console.warn('RESEND_API_KEY absente : email non envoyé (mode test) ->', destinataire, sujet);
    return false;
  }
  try{
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + RESEND_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ from: MAIL_FROM, to: [destinataire], subject: sujet, html })
    });
    if(!r.ok){ console.error('Resend a refusé l\'envoi :', await r.text()); return false; }
    return true;
  }catch(e){
    console.error('Envoi d\'email impossible :', e.message);
    return false;
  }
}

/* ---------- outils ---------- */
const cle = p => p.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9_-]/g,'');

function hacher(mdp, sel){
  return crypto.scryptSync(mdp, sel, 32).toString('hex');
}
function nouveauJeton(){ return crypto.randomBytes(24).toString('hex'); }

function parJeton(jeton){
  if(!jeton) return null;
  for(const k in base.joueurs){
    if((base.joueurs[k].jetons||[]).includes(jeton)) return base.joueurs[k];
  }
  return null;
}
function parEmail(email){
  const e = String(email||'').trim().toLowerCase();
  if(!e) return null;
  for(const k in base.joueurs){
    if((base.joueurs[k].email||'').toLowerCase() === e) return base.joueurs[k];
  }
  return null;
}
const fiche = j => ({ pseudo:j.pseudo, tete:j.tete, arbres:j.arbres||0, serie:j.serie||0,
  minutes:j.minutes||0, xp:j.xp||0, achetes:j.achetes||[] });

/* ---------- routes ---------- */
const routes = {

  async inscription({ pseudo, email, mdp, tete }){
    pseudo = String(pseudo||'').trim();
    email  = String(email||'').trim();
    if(pseudo.length < 3)  throw 'Pseudo trop court (3 caractères minimum).';
    if(pseudo.length > 16) throw 'Pseudo trop long (16 caractères maximum).';
    if(!emailValide(email)) throw 'Adresse email invalide.';
    if(String(mdp||'').length < 6) throw 'Mot de passe trop court (6 caractères minimum).';
    const k = cle(pseudo);
    if(!k) throw 'Pseudo invalide.';
    if(base.joueurs[k]) throw 'Ce pseudo est déjà pris.';
    if(parEmail(email)) throw 'Un compte existe déjà avec cet email.';

    const sel = crypto.randomBytes(16).toString('hex');
    const jeton = nouveauJeton();
    base.joueurs[k] = {
      pseudo, email, sel, hash: hacher(mdp, sel), tete: tete || '🌱',
      arbres:0, serie:0, minutes:0, xp:0, achetes:[], amis:[], jetons:[jeton], cree: Date.now()
    };
    enregistrer();
    return { jeton, joueur: fiche(base.joueurs[k]) };
  },

  async connexion({ pseudo, mdp }){
    const identifiant = String(pseudo||'').trim();
    const j = base.joueurs[cle(identifiant)] || parEmail(identifiant);
    if(!j) throw 'Compte inconnu.';
    if(hacher(String(mdp||''), j.sel) !== j.hash) throw 'Mot de passe incorrect.';
    const jeton = nouveauJeton();
    j.jetons = [...(j.jetons||[]).slice(-4), jeton];   // 5 appareils maximum
    enregistrer();
    return { jeton, joueur: fiche(j), amis: j.amis||[] };
  },

  async motDePasseOublie({ email }){
    const j = parEmail(email);
    // toujours la même réponse, qu'un compte existe ou non (évite de révéler qui est inscrit)
    if(j){
      j.resetToken = crypto.randomBytes(24).toString('hex');
      j.resetExpire = Date.now() + 30*60*1000;   // 30 minutes
      enregistrer();
      const lien = (FRONT_URL || '') + '?reset=' + j.resetToken;
      await envoyerEmail(j.email, 'Réinitialise ton mot de passe Fociz', `
        <p>Salut ${j.pseudo},</p>
        <p>Clique sur ce lien pour choisir un nouveau mot de passe (valable 30 minutes) :</p>
        <p><a href="${lien}">${lien}</a></p>
        <p>Si tu n'es pas à l'origine de cette demande, ignore cet email.</p>
      `);
    }
    return { ok:true };
  },

  async reinitialiser({ token, mdp }){
    token = String(token||'');
    if(String(mdp||'').length < 6) throw 'Mot de passe trop court (6 caractères minimum).';
    let cible = null;
    for(const k in base.joueurs){
      const j = base.joueurs[k];
      if(j.resetToken && j.resetToken === token) { cible = j; break; }
    }
    if(!cible) throw 'Lien invalide.';
    if(!cible.resetExpire || cible.resetExpire < Date.now()) throw 'Ce lien a expiré, refais une demande.';

    const sel = crypto.randomBytes(16).toString('hex');
    cible.sel = sel;
    cible.hash = hacher(mdp, sel);
    delete cible.resetToken;
    delete cible.resetExpire;
    const jeton = nouveauJeton();
    cible.jetons = [jeton];   // on déconnecte les autres appareils par sécurité
    enregistrer();
    return { jeton, joueur: fiche(cible) };
  },

  async sync({ jeton, arbres, serie, minutes, tete, xp, achetes }){
    const j = parJeton(jeton);
    if(!j) throw 'Session expirée, reconnecte-toi.';
    if(Number.isFinite(arbres))  j.arbres  = Math.max(j.arbres||0,  Math.floor(arbres));
    if(Number.isFinite(serie))   j.serie   = Math.floor(serie);
    if(Number.isFinite(minutes)) j.minutes = Math.max(j.minutes||0, Math.floor(minutes));
    if(Number.isFinite(xp))      j.xp      = Math.max(0, Math.floor(xp));
    if(Array.isArray(achetes)){
      const propres = achetes.filter(id => typeof id === 'string').slice(0, 50);
      j.achetes = Array.from(new Set([...(j.achetes||[]), ...propres]));
    }
    if(tete) j.tete = tete;
    enregistrer();
    return { joueur: fiche(j) };
  },

  async ami({ jeton, action, pseudo }){
    const j = parJeton(jeton);
    if(!j) throw 'Session expirée, reconnecte-toi.';
    const k = cle(pseudo||'');
    if(!k) throw 'Pseudo invalide.';
    if(k === cle(j.pseudo)) throw "C'est toi, ça.";
    j.amis = j.amis || [];
    if(action === 'retirer'){
      j.amis = j.amis.filter(a => cle(a) !== k);
    }else{
      const cible = base.joueurs[k];
      if(!cible) throw 'Aucun joueur avec ce pseudo.';
      if(!j.amis.some(a => cle(a) === k)) j.amis.push(cible.pseudo);
    }
    enregistrer();
    return { amis: j.amis };
  },

  async classement({ jeton }){
    const j = parJeton(jeton);
    if(!j) throw 'Session expirée, reconnecte-toi.';
    const liste = [ { ...fiche(j), moi:true } ];
    for(const a of (j.amis||[])){
      const ami = base.joueurs[cle(a)];
      if(ami) liste.push({ ...fiche(ami), moi:false });
    }
    liste.sort((x,y) => y.arbres - x.arbres || y.serie - x.serie || y.minutes - x.minutes);
    return { classement: liste };
  }
};

const SITE_FICHIER = process.env.SITE_FILE || path.join(__dirname, 'fociz.html');

/* ---------- serveur HTTP ---------- */
const serveur = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');

  if(req.method === 'OPTIONS'){ res.writeHead(204); return res.end(); }

  if(req.url === '/sante'){                      // pour vérifier que ça tourne
    res.writeHead(200, {'Content-Type':'application/json'});
    return res.end(JSON.stringify({ ok:true, joueurs:Object.keys(base.joueurs).length }));
  }

  // toute requête GET qui n'est pas une route API sert directement le site
  if(req.method === 'GET' && !req.url.startsWith('/api/')){
    try{
      const html = fs.readFileSync(SITE_FICHIER, 'utf8');
      res.writeHead(200, {'Content-Type':'text/html; charset=utf-8'});
      return res.end(html);
    }catch(e){
      res.writeHead(503, {'Content-Type':'text/plain; charset=utf-8'});
      return res.end("Le fichier fociz.html n'est pas encore présent sur le serveur.");
    }
  }

  const nom = (req.url || '').replace('/api/','').split('?')[0];
  if(req.method !== 'POST' || !routes[nom]){
    res.writeHead(404, {'Content-Type':'application/json'});
    return res.end(JSON.stringify({ erreur:'Route inconnue' }));
  }

  let corps = '';
  req.on('data', c => {
    corps += c;
    if(corps.length > 10000) req.destroy();       // anti-abus
  });
  req.on('end', async () => {
    try{
      const donnees = corps ? JSON.parse(corps) : {};
      const reponse = await routes[nom](donnees);
      res.writeHead(200, {'Content-Type':'application/json'});
      res.end(JSON.stringify(reponse));
    }catch(e){
      const msg = typeof e === 'string' ? e : 'Erreur du serveur';
      res.writeHead(typeof e === 'string' ? 400 : 500, {'Content-Type':'application/json'});
      res.end(JSON.stringify({ erreur: msg }));
    }
  });
});

serveur.listen(PORT, () => console.log('Fociz écoute sur le port ' + PORT));
