# Stripe en live : marche à suivre

Passer de Stripe test à Stripe live ne demande **aucun changement de code** :
les prix sont référencés par `lookup_key`, les clés viennent de l'environnement.
Ce document dit quoi créer dans Stripe, dans quel ordre, quoi coller dans
Railway, et comment vérifier avec un vrai paiement remboursé.

Tout se fait dans le tableau de bord Stripe **en mode live** (interrupteur en
haut à droite). Les objets du mode test ne sont pas copiés : il faut les recréer.

> Aucune clé ne s'écrit dans le dépôt, dans une issue ou dans un message. Elles
> se collent dans Railway → service `cortex-app` → Variables, et nulle part ailleurs.

---

## 1. Avant de commencer

- [ ] Compte Stripe activé en live (identité, IBAN). Un compte **séparé de
      Kairo** est préférable : libellé bancaire, pied de facture et e-mails sont
      réglés au niveau du compte. (Le code tolère un compte partagé : le webhook
      ignore tout ce qui ne porte pas Cortex.)
- [ ] Les quatre pages légales sont en ligne sur la vitrine et l'app les lie
      (`LANDING_URL` ou `LEGAL_*_URL`) : sans elles, la vente reste fermée.
- [ ] Cette version est déployée (`/api/health` répond `ok`).
- [ ] Une sauvegarde fraîche existe : `npm run backup -- --push --label=avant-live`.

## 2. Réglages du compte

**Paramètres → Entreprise → Informations publiques**

| Champ | Valeur |
|---|---|
| Nom public | `Cortex` |
| E-mail d'assistance | `abensur.benjamin@gmail.com` |
| Site web | l'URL de la vitrine |
| Libellé de relevé bancaire | `BENABENS CORTEX` |
| Libellé abrégé (préfixe, cartes) | `BENABENS` |

Le libellé complet fait entre 5 et 22 caractères, le préfixe entre 2 et 10.
Sur un pack, le code ajoute le suffixe `CORTEX` : le relevé affiche
`BENABENS* CORTEX`. Un abonnement prend le libellé de son produit (étape 3),
sinon celui du compte.

**Paramètres → Paiements → Moyens de paiement** : cartes, Apple Pay, Google Pay,
Link. **Laisse désactivés les moyens à confirmation différée** (prélèvement
SEPA, virement) pour l'instant : l'abonnement y est « actif » plusieurs jours
avant que l'argent n'arrive, et les crédits n'étant donnés qu'à la facture
payée, l'abonné attendrait sans comprendre.

**Paramètres → Facturation → Factures**

| Réglage | Valeur |
|---|---|
| Pied de page par défaut | `Benjamin Abensur EI – Benabens – SIREN 130 707 144 – TVA non applicable, art. 293 B du CGI` |
| Numérotation | séquentielle **au niveau du compte** (pas par client) |
| Langue par défaut | français |

**Paramètres → Facturation → Abonnements et e-mails**

| Réglage | Valeur |
|---|---|
| E-mails de paiement réussi (reçus) | activés |
| E-mails de remboursement | activés |
| E-mails de renouvellement à venir | activés, délai de **30 jours** : les CGV promettent une information avant chaque reconduction, et pour l'annuel elle doit partir au plus tard un mois avant l'échéance |
| E-mails d'échec de paiement, lien de mise à jour de la carte | activés, lien vers le portail client |
| Relances intelligentes (Smart Retries) | activées |
| Si toutes les relances échouent | **annuler l'abonnement** |

« Annuler l'abonnement » est le bon choix ici : l'abonné impayé n'a plus de
crédits d'abonnement dès le premier échec, et l'annulation finale lui permet de
se réabonner proprement. Avec « laisser impayé », il resterait bloqué sur un
abonnement mort.

**Stripe Tax** : ne pas l'activer (franchise en base de TVA).

## 3. Produits et prix

**Catalogue de produits → Ajouter un produit.** La `lookup_key` se saisit sur le
**prix** (« Clé de recherche »). C'est elle que l'app lit, jamais l'identifiant.

| Produit | Prix | Facturation | `lookup_key` |
|---|---|---|---|
| Cortex : pack de 10 crédits | 9,00 EUR | paiement unique | `cortex_credits_10` |
| Cortex Pro | 14,90 EUR | récurrent, mensuel | `cortex_pro_monthly` |
| Cortex Pro | 119,00 EUR | récurrent, annuel | `cortex_pro_yearly` |

- Les deux prix récurrents vont sur le **même** produit « Cortex Pro ».
- Sur le produit « Cortex Pro », pose le **libellé de relevé** `BENABENS CORTEX`.
- Pas d'essai gratuit, pas de code promotionnel côté client.
- L'app n'utilise que les prix **actifs**. Pour changer un tarif : crée un
  nouveau prix, transfère-lui la `lookup_key`, archive l'ancien.
- `CREDIT_PRICE_CENTS` (défaut 90) doit rester égal au prix du pack divisé par
  dix : il sert à convertir en crédits un remboursement dont l'achat est inconnu.

## 4. Webhook

**Développeurs → Webhooks → Ajouter une destination.**

- URL : `https://<domaine de l'app>/api/billing/webhook`
- Version d'API : `2026-06-24.dahlia` si elle est proposée, sinon la plus
  récente (le traitement lit les deux familles de formats).
- Événements, **ces sept-là et aucun autre** :

| Événement | Ce que l'app en fait |
|---|---|
| `checkout.session.completed` | crédite un pack payé ; lie un abonnement à son compte |
| `checkout.session.async_payment_succeeded` | même chose pour un paiement confirmé après coup |
| `invoice.paid` | ouvre la période payée et remet le mois à 20 crédits |
| `customer.subscription.updated` | suit le statut (en règle, retard de paiement, résiliation programmée) |
| `customer.subscription.deleted` | fin de l'abonnement : crédits du mois à 0 |
| `charge.refunded` | reprend les crédits d'un pack ou suspend l'abonnement remboursé |
| `charge.dispute.created` | même reprise pour un litige |

N'ajoute **pas** `invoice.created` : si l'endpoint ne lui répond pas, Stripe
retarde la finalisation de toutes les factures jusqu'à 72 heures.

Copie le **secret de signature** (`whsec_…`) pour l'étape 7.

## 5. Portail client

**Paramètres → Facturation → Portail client.** C'est par lui que l'abonné
change de carte, télécharge ses factures et résilie (bouton « Gérer mon
abonnement » de l'app).

| Fonctionnalité | Réglage |
|---|---|
| Mettre à jour le moyen de paiement | activé |
| Historique des factures | activé |
| Résilier un abonnement | activé, **à la fin de la période de facturation** |
| Changer d'offre | **désactivé** |
| Mettre en pause | désactivé |
| Informations de l'entreprise | liens vers les CGV et la politique de confidentialité |

« Changer d'offre » reste désactivé : un passage mensuel → annuel produit une
facture au prorata que l'app ne lit pas comme une période entière. Pour changer
d'offre, l'abonné résilie puis se réabonne à l'échéance.

## 6. Clé d'API

**Développeurs → Clés API → Créer une clé restreinte** (`rk_live_…`), plutôt
que la clé secrète : elle ne peut faire que ce dont l'app a besoin.

| Ressource | Droit | Utilisé pour |
|---|---|---|
| Checkout Sessions | écriture | créer et expirer une session de paiement, retrouver celle d'un remboursement |
| Prices | lecture | afficher les prix, résoudre les `lookup_key` |
| Customer portal | écriture | ouvrir le portail |
| Invoices | lecture | retrouver la facture d'un paiement remboursé |
| Subscriptions | écriture | programmer la résiliation (rétractation), résilier à la suppression du compte |

Tout le reste : aucun. S'il manque un droit, Stripe répond 403 en nommant la
permission : ajoute-la à la clé. Une clé secrète `sk_live_…` fonctionne aussi.

## 7. Variables Railway

Service `cortex-app` → Variables. Deux valeurs changent :

| Variable | Valeur |
|---|---|
| `STRIPE_SECRET_KEY` | la clé live de l'étape 6 (`rk_live_…` ou `sk_live_…`) |
| `STRIPE_WEBHOOK_SECRET` | le `whsec_…` de l'endpoint **live** de l'étape 4 |

Les deux se changent **ensemble** : le webhook refuse un événement live signé
pour une clé de test, et l'inverse. À vérifier au passage, sans les modifier si
elles sont déjà justes :

| Variable | Attendu |
|---|---|
| `BILLING_ENABLED` | `1` |
| `AUTH_URL` | l'URL publique de l'app (retours de paiement, portail) |
| `LANDING_URL` ou les quatre `LEGAL_*_URL` | les pages légales en ligne |
| `LEGAL_TERMS_VERSION` | la version des CGV publiées |
| `SIGNUP_FREE_CREDITS` | `2` |
| `SUBSCRIPTION_MONTHLY_CREDITS` | `20` (ou absente) |
| `PUBLISHER_EMAIL` | l'adresse qui reçoit les demandes de rétractation |

Tant que la clé est une clé de test et que l'instance est ouverte au public,
la page « Abonnement & crédits » affiche « Les achats ouvrent bientôt » et le
paiement est refusé : une carte de test donnerait de vrais crédits. Coller la
clé live ouvre la vente, sans autre réglage.

## 8. Données laissées par le mode test

Les abonnements et achats faits en mode test sont dans la base de production.
Stripe live ne les connaît pas : un abonnement de test resterait « actif », un
annuel continuerait de recevoir 20 crédits par mois jusqu'à sa fin, et le
bouton « Gérer mon abonnement » échouerait.

**À lancer toi-même** dans Railway → Postgres → Data → Query, **après** avoir
collé les clés live et **avant** le premier abonnement réel (rien ne distingue
un abonnement de test d'un vrai une fois qu'il y en a des deux sortes) :

```sql
-- 1. Regarder ce qui existe
SELECT user_id, status, plan, remaining, period_end FROM public.subscriptions;

-- 2. Effacer les abonnements et factures du mode test
BEGIN;
DELETE FROM public.stripe_invoices;
DELETE FROM public.subscriptions;
COMMIT;
```

Les crédits des **packs** achetés en test restent au solde des comptes qui les
ont reçus. Pour les voir, et décider s'ils restent offerts à tes testeurs :

```sql
SELECT user_id, sum(delta) / 100.0 AS credits_de_test
FROM public.credit_transactions
WHERE ref LIKE 'stripe:cs:cs_test_%'
GROUP BY user_id;
```

## 9. Ordre des opérations

1. Réglages du compte (§ 2), produits et prix (§ 3), portail (§ 5).
2. Endpoint webhook live (§ 4), clé restreinte (§ 6).
3. Sauvegarde : `npm run backup -- --push --label=avant-live`.
4. Railway : les deux variables (§ 7). Le service redémarre (environ une minute).
5. Nettoyage des données de test (§ 8).
6. Test de bout en bout (§ 10).
7. Seulement ensuite : annoncer que la vente est ouverte.

## 10. Test de bout en bout, en live, avec remboursement

Avec ta propre carte, sur un compte Cortex à toi. Coût réel : les frais Stripe
des paiements remboursés (ils ne sont pas rendus), soit moins d'un euro.

**Pack**

1. Page « Abonnement & crédits » : les trois offres affichent leur prix
   (`9 €`, `14,90 € / mois`, `119 € / an`), aucun bandeau « ouvrent bientôt ».
2. Accepter les CGV, cocher le consentement du pack, **Acheter**, payer.
3. Vérifier :
   - retour sur l'app, solde **+10** en quelques secondes ;
   - Stripe → Développeurs → Webhooks : `checkout.session.completed` livré en **200** ;
   - e-mail de reçu avec la facture, son numéro et le pied de page ;
   - sur le relevé de carte : `BENABENS* CORTEX`.
4. Stripe → Paiements → le paiement → **Rembourser** en totalité.
5. Vérifier : `charge.refunded` livré en 200, solde **−10** dans l'app, e-mail
   de remboursement reçu.

**Abonnement mensuel**

1. **S'abonner** au mensuel, payer.
2. Vérifier : `invoice.paid` livré en 200, « actif », **20 / 20 crédits ce
   mois-ci**, date de recharge un mois plus tard.
3. « Gérer mon abonnement » : le portail s'ouvre, la facture est téléchargeable.
   Résilier. De retour dans l'app : **« résiliation programmée »**, « se termine
   le … », plus de « recharge le ».
4. Stripe → Paiements → rembourser le paiement de 14,90 €. Vérifier : l'app
   affiche « suspendu », 0 crédit d'abonnement.
5. Stripe → Abonnements → l'abonnement → **Annuler immédiatement**. Vérifier :
   « Aucun abonnement », l'offre est de nouveau proposée.

**Journal** : Railway → Observability, chercher `stripe.reversal_unresolved`.
Il ne doit pas apparaître. S'il apparaît, un remboursement n'a pas retrouvé son
achat : à traiter à la main.

## 11. Règles de crédits à connaître avant d'ouvrir

- **Pas de paiement, pas de crédits d'abonnement.** Les crédits viennent d'une
  facture payée. Un renouvellement en échec ne donne rien : ni le reliquat du
  mois précédent, ni une nouvelle fenêtre pour un annuel. Les mois impayés ne
  sont pas rattrapés.
- **Rien ne se reporte.** Chaque période payée remet le compteur à 20.
- **Les crédits achetés et les 2 crédits offerts restent acquis**, quel que soit
  l'état de l'abonnement.
- **Une heure sans crédits d'abonnement à chaque renouvellement.** Stripe
  crée la facture de renouvellement en brouillon et ne l'encaisse qu'environ une
  heure plus tard. Pendant ce délai l'app affiche « renouvellement en cours » ;
  les 20 crédits arrivent avec le paiement.
- **Paiement en échec** : l'app affiche « paiement en échec » et renvoie vers le
  portail. L'abonné ne peut pas ouvrir un second abonnement tant que le premier
  n'est pas réglé ou annulé.
- **Remboursement ou litige sur une facture** : abonnement suspendu jusqu'à la
  prochaine facture payée ; ce qui a été consommé passe en dette.

## 12. Revenir en arrière

Remettre les deux valeurs de test dans Railway referme la vente publique
(clé de test + instance ouverte) sans toucher aux crédits déjà achetés. Les
abonnements live continuent d'exister chez Stripe : les résilier depuis le
tableau de bord si l'arrêt est durable.
