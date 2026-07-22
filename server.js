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
const ADMIN_KEY = process.env.ADMIN_KEY || '';   // vide = page /admin désactivée

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

function cleAdminValide(cle){
  if(!ADMIN_KEY) return false;
  const a = Buffer.from(String(cle||''));
  const b = Buffer.from(ADMIN_KEY);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

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

/* ---------- sessions de groupe (éphémères, en mémoire — pas dans le fichier JSON) ---------- */
const sessions = {};   // code -> { hote, hoteJeton, minutes, maxParticipants, participants:{jeton:{pseudo,tete}}, demarree, demarreeA, creeLe }
const ALPHABET_CODE = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';   // sans 0/O/1/I/L, pour éviter la confusion

function nouveauCode(){
  let code;
  do{
    code = Array.from({length:5}, () => ALPHABET_CODE[Math.floor(Math.random()*ALPHABET_CODE.length)]).join('');
  } while(sessions[code]);
  return code;
}
function sessionFiche(s, code){
  // volontairement : juste le nombre de participants, jamais la liste de leurs pseudos
  return { code, hote:s.hote, minutes:s.minutes, maxParticipants:s.maxParticipants,
    nombre:Object.keys(s.participants).length, demarree:s.demarree, demarreeA:s.demarreeA };
}
setInterval(() => {                                        // ménage : sessions de plus de 3h
  const seuil = Date.now() - 3*60*60*1000;
  for(const c in sessions){ if(sessions[c].creeLe < seuil) delete sessions[c]; }
}, 30*60*1000);

/* ---------- présence (compteur global, anonyme — pas de pseudo, pas de compte requis) ---------- */
const presences = {};   // id anonyme -> { vu, enSession }
setInterval(() => {                                        // ménage : plus vu depuis 5 min
  const seuil = Date.now() - 5*60*1000;
  for(const id in presences){ if(presences[id].vu < seuil) delete presences[id]; }
}, 60*1000);

/* ---------- routes ---------- */
const routes = {

  async sessionCreer({ jeton, minutes, maxParticipants }){
    const j = parJeton(jeton);
    if(!j) throw 'Connecte-toi d\'abord.';
    minutes = Math.max(1, Math.min(180, parseInt(minutes)||45));
    maxParticipants = Math.max(2, Math.min(30, parseInt(maxParticipants)||10));
    const code = nouveauCode();
    sessions[code] = { hote:j.pseudo, hoteJeton:jeton, minutes, maxParticipants,
      participants:{ [jeton]:{ pseudo:j.pseudo, tete:j.tete } }, demarree:false, demarreeA:null, creeLe:Date.now() };
    return sessionFiche(sessions[code], code);
  },

  async sessionRejoindre({ jeton, code }){
    const j = parJeton(jeton);
    if(!j) throw 'Connecte-toi d\'abord.';
    code = String(code||'').trim().toUpperCase();
    const s = sessions[code];
    if(!s) throw 'Code inconnu.';
    const deja = s.participants[jeton];
    if(!deja && Object.keys(s.participants).length >= s.maxParticipants) throw 'Session complète.';
    s.participants[jeton] = { pseudo:j.pseudo, tete:j.tete };
    return sessionFiche(s, code);
  },

  async sessionEtat({ code }){
    code = String(code||'').trim().toUpperCase();
    const s = sessions[code];
    if(!s) throw 'Code inconnu.';
    return sessionFiche(s, code);
  },

  async sessionDemarrer({ jeton, code }){
    code = String(code||'').trim().toUpperCase();
    const s = sessions[code];
    if(!s) throw 'Code inconnu.';
    if(s.hoteJeton !== jeton) throw 'Seul l\'hôte peut démarrer.';
    if(!s.demarree){ s.demarree = true; s.demarreeA = Date.now(); }
    return sessionFiche(s, code);
  },

  async sessionQuitter({ jeton, code }){
    code = String(code||'').trim().toUpperCase();
    const s = sessions[code];
    if(s) delete s.participants[jeton];
    return { ok:true };
  },

  async presence({ id, enSession }){
    id = String(id||'').slice(0,64);
    if(!id) throw 'id manquant';
    presences[id] = { vu: Date.now(), enSession: !!enSession };
    const seuil = Date.now() - 90*1000;   // "en ligne" = vu dans les 90 dernières secondes
    let enLigne=0, enSess=0;
    for(const k in presences){
      if(presences[k].vu >= seuil){ enLigne++; if(presences[k].enSession) enSess++; }
    }
    return { enLigne, enSession: enSess };
  },

  async profilModifier({ jeton, pseudo, email, tete }){
    const j = parJeton(jeton);
    if(!j) throw 'Connecte-toi d\'abord.';
    const ancienneCle = cle(j.pseudo);

    if(pseudo !== undefined && String(pseudo||'').trim() !== ''){
      pseudo = String(pseudo).trim();
      if(pseudo.length < 3)  throw 'Pseudo trop court (3 caractères minimum).';
      if(pseudo.length > 16) throw 'Pseudo trop long (16 caractères maximum).';
      const nouvelleCle = cle(pseudo);
      if(!nouvelleCle) throw 'Pseudo invalide.';
      if(nouvelleCle !== ancienneCle){
        if(base.joueurs[nouvelleCle]) throw 'Ce pseudo est déjà pris.';
        delete base.joueurs[ancienneCle];
        base.joueurs[nouvelleCle] = j;
      }
      j.pseudo = pseudo;
    }

    if(email !== undefined && String(email||'').trim() !== ''){
      email = String(email).trim();
      if(!emailValide(email)) throw 'Adresse email invalide.';
      const existant = parEmail(email);
      if(existant && existant !== j) throw 'Un compte existe déjà avec cet email.';
      j.email = email;
    }

    if(tete) j.tete = tete;

    enregistrer();
    return { joueur: fiche(j) };
  },

  async mdpModifier({ jeton, ancien, nouveau }){
    const j = parJeton(jeton);
    if(!j) throw 'Connecte-toi d\'abord.';
    if(hacher(String(ancien||''), j.sel) !== j.hash) throw 'Mot de passe actuel incorrect.';
    if(String(nouveau||'').length < 6) throw 'Nouveau mot de passe trop court (6 caractères minimum).';
    const sel = crypto.randomBytes(16).toString('hex');
    j.sel = sel;
    j.hash = hacher(nouveau, sel);
    enregistrer();
    return { ok:true };
  },

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

  async adminComptes({ cle }){
    if(!cleAdminValide(cle)) throw 'Accès refusé.';
    const joueurs = Object.values(base.joueurs).map(j => ({
      pseudo: j.pseudo, email: j.email||'', tete: j.tete,
      arbres: j.arbres||0, serie: j.serie||0, minutes: j.minutes||0, xp: j.xp||0,
      achetes: j.achetes||[], amis: j.amis||[], cree: j.cree||null
    }));
    joueurs.sort((a,b) => (b.cree||0) - (a.cree||0));
    return { joueurs };
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

/* ---------- page /admin (liste des comptes, protégée par ADMIN_KEY) ---------- */
const PAGE_ADMIN = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Fociz — comptes</title>
<style>
  body{margin:0;padding:24px 16px 40px;background:#F3F1E6;color:#2E3A22;font-family:system-ui,sans-serif}
  .wrap{max-width:760px;margin:0 auto}
  h1{font-size:20px}
  .barre{display:flex;gap:8px;margin-bottom:18px}
  input{flex:1;padding:10px 12px;border-radius:10px;border:1.5px solid #E4E1D2;font-size:14px}
  button{padding:10px 16px;border-radius:10px;border:none;background:#6B8F52;color:#fff;font-weight:600;cursor:pointer}
  table{width:100%;border-collapse:collapse;font-size:13.5px;background:#fff;border-radius:12px;overflow:hidden}
  th,td{text-align:left;padding:9px 10px;border-bottom:1px solid #E4E1D2}
  th{background:#EEF0E4}
  .msg{font-size:13px;color:#B97452;margin-bottom:10px}
  .compte{font-size:12.5px;color:#8A8F79;margin-bottom:14px}
</style>
</head>
<body>
<div class="wrap">
  <h1>Comptes Fociz</h1>
  <div class="barre">
    <input type="password" id="cle" placeholder="Clé admin" autocomplete="off">
    <button id="voir">Voir</button>
  </div>
  <div class="msg" id="msg"></div>
  <div class="compte" id="compte"></div>
  <table id="tab" hidden>
    <thead><tr><th>Pseudo</th><th>Email</th><th>Arbres</th><th>Série</th><th>Minutes</th><th>XP</th><th>Créé le</th></tr></thead>
    <tbody id="corps"></tbody>
  </table>
</div>
<script>
const cle=document.getElementById('cle'), msg=document.getElementById('msg'),
      tab=document.getElementById('tab'), corps=document.getElementById('corps'),
      compte=document.getElementById('compte');
cle.value=sessionStorage.getItem('adminCle')||'';
async function charger(){
  msg.textContent=''; tab.hidden=true; corps.innerHTML=''; compte.textContent='';
  try{
    const r=await fetch('/api/adminComptes',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({cle:cle.value})});
    const d=await r.json();
    if(!r.ok) throw new Error(d.erreur||'Erreur');
    sessionStorage.setItem('adminCle',cle.value);
    compte.textContent=d.joueurs.length+' compte(s)';
    d.joueurs.forEach(j=>{
      const tr=document.createElement('tr');
      const vals=[j.pseudo, j.email, j.arbres, j.serie, j.minutes, j.xp,
        j.cree?new Date(j.cree).toLocaleDateString('fr-FR'):''];
      vals.forEach(v=>{ const td=document.createElement('td'); td.textContent=v; tr.appendChild(td); });
      corps.appendChild(tr);
    });
    tab.hidden=false;
  }catch(e){ msg.textContent=e.message; }
}
document.getElementById('voir').onclick=charger;
cle.addEventListener('keydown',e=>{ if(e.key==='Enter') charger(); });
if(cle.value) charger();
</script>
</body>
</html>`;

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

  if(req.method === 'GET' && req.url.split('?')[0] === '/admin'){
    res.writeHead(200, {'Content-Type':'text/html; charset=utf-8'});
    return res.end(PAGE_ADMIN);
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
