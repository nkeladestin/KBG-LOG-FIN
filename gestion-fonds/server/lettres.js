'use strict';
/** Conversion d'un montant en toutes lettres (français), pour les ordres de virement et bons de caisse. */

const UNITES = ['zéro', 'un', 'deux', 'trois', 'quatre', 'cinq', 'six', 'sept', 'huit', 'neuf', 'dix',
  'onze', 'douze', 'treize', 'quatorze', 'quinze', 'seize', 'dix-sept', 'dix-huit', 'dix-neuf'];
const DIZAINES = ['', '', 'vingt', 'trente', 'quarante', 'cinquante', 'soixante'];

function moinsDeCent(n, final) {
  if (n < 20) return UNITES[n];
  const d = Math.floor(n / 10);
  const u = n % 10;
  if (d <= 6) {
    if (u === 0) return DIZAINES[d];
    if (u === 1) return `${DIZAINES[d]} et un`;
    return `${DIZAINES[d]}-${UNITES[u]}`;
  }
  if (d === 7) return u === 1 ? 'soixante et onze' : `soixante-${UNITES[10 + u]}`;
  if (d === 8) return u === 0 ? (final ? 'quatre-vingts' : 'quatre-vingt') : `quatre-vingt-${UNITES[u]}`;
  return `quatre-vingt-${UNITES[10 + u]}`; // 90-99
}

/** final = le groupe termine le nombre ou précède « millions/milliards » (accord de cent et vingt). */
function moinsDeMille(n, final) {
  const c = Math.floor(n / 100);
  const r = n % 100;
  let s = '';
  if (c > 0) {
    s = c === 1 ? 'cent' : `${UNITES[c]} cent`;
    if (r === 0 && c > 1 && final) s += 's';
  }
  if (r > 0) s += (s ? ' ' : '') + moinsDeCent(r, final);
  return s;
}

function entierEnLettres(n) {
  n = Math.floor(Math.abs(n));
  if (n === 0) return 'zéro';
  const groupes = [
    [1e9, 'milliard', 'milliards'],
    [1e6, 'million', 'millions'],
  ];
  const parts = [];
  for (const [val, sing, plur] of groupes) {
    const q = Math.floor(n / val);
    if (q > 0) {
      parts.push(`${entierEnLettres(q) === 'un' ? 'un' : moinsDeMilleEtPlus(q, true)} ${q > 1 ? plur : sing}`);
      n %= val;
    }
  }
  const milliers = Math.floor(n / 1000);
  if (milliers > 0) {
    parts.push(milliers === 1 ? 'mille' : `${moinsDeMille(milliers, false)} mille`);
    n %= 1000;
  }
  if (n > 0) parts.push(moinsDeMille(n, true));
  return parts.join(' ');
}

function moinsDeMilleEtPlus(q, final) {
  return q < 1000 ? moinsDeMille(q, final) : entierEnLettres(q);
}

/**
 * montantEnLettres(1250500, 'francs CFA') → « Un million deux cent cinquante mille cinq cents francs CFA »
 * La subdivision est ajoutée s'il y en a : « ... dollars américains et quarante-cinq cents ».
 */
function montantEnLettres(montant, deviseLettres = '', subdivision = 'cents') {
  const m = Math.round(Math.abs(Number(montant) || 0) * 100);
  const entier = Math.floor(m / 100);
  const cts = m % 100;
  let s = entierEnLettres(entier);
  // « un million de francs », « deux millions d'euros »
  if (deviseLettres && /(million|milliard)s?$/.test(s)) s += /^[aeiouyéèh]/i.test(deviseLettres) ? " d'" : ' de ';
  else if (deviseLettres) s += ' ';
  s += deviseLettres;
  if (cts > 0) {
    const sub = subdivision || 'cents';
    s += ` et ${entierEnLettres(cts)} ${cts > 1 ? sub : sub.replace(/s$/, '')}`;
  }
  s = s.replace(/ d' /, " d'").trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

module.exports = { montantEnLettres, entierEnLettres };
