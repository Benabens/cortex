/**
 * TYPES POSTGRES LUS COMME EN SQLITE. `postgres.js` rend un bigint (int8 : tout
 * `count(*)`, un `sum(...)::bigint`) en CHAÎNE, pour ne rien perdre au-delà de 2^53 ;
 * SQLite et PGlite (les tests) rendent un nombre. Le code, écrit pour SQLite, compare
 * et additionne ces valeurs : en prod, « 0 » passait pour vrai (`if (!items)`), et un
 * outil MCP renvoyait des chaînes là où son schéma attend des nombres (27/10/2026).
 * Aucune colonne du schéma n'est en bigint : seuls des agrégats, très loin de 2^53.
 */
export const PG_TYPES = {
  bigint: { to: 20, from: [20], serialize: (x: unknown) => String(x), parse: (x: string) => Number(x) },
};
