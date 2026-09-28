import Stripe from "stripe";

/**
 * CLIENT STRIPE UNIQUE, version d'API ÉPINGLÉE.
 *
 * Sans épinglage, Stripe sert (et signe pour le webhook) les objets au format
 * de la version par défaut du COMPTE, qui peut changer dans le tableau de bord :
 * en production, la facture d'un abonnement est arrivée au format récent
 * (famille « basil » 2025+ : plus de invoice.subscription, invoice.payment_intent,
 * line.price ni charge.invoice) et n'a accordé aucun crédit. Le code lit les
 * DEUX formats (lib/billing/stripe-events), et la version ci-dessous est celle
 * que le SDK installé (stripe@22) type et attend : toute montée de version du
 * SDK doit la mettre à jour ensemble (le test stripe-events le vérifie).
 *
 * L'épinglage côté SDK gouverne les APPELS sortants ; le format des ÉVÉNEMENTS
 * entrants est celui de l'endpoint webhook (version choisie à sa création dans
 * le tableau de bord) — d'où la lecture bi-format.
 */
export const STRIPE_API_VERSION = "2026-06-24.dahlia";

export function stripeClient(key: string): Stripe {
  return new Stripe(key, { apiVersion: STRIPE_API_VERSION });
}
