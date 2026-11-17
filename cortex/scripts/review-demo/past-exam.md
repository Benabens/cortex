# DEMO-101 Probability: practice final exam with solutions

*Demo material written for the Cortex reviewer account. It is not taken from any real course.*

Written exam, 2 hours, no documents allowed, no calculator. 5 exercises, 20 points each.

## Exercise 1 (20 points)

A fair die is rolled 10 times. Let X be the number of sixes.

1. Give the distribution of X. (5 points)
2. Compute E[X] and Var(X). (5 points)
3. Compute P(X ≥ 1). (10 points)

**Solution.** X ~ Binomial(10, 1/6). E[X] = 10/6 = 5/3 and Var(X) = 10 · (1/6) · (5/6) = 25/18.
P(X ≥ 1) = 1 − P(X = 0) = 1 − (5/6)^10.

## Exercise 2 (20 points)

A box holds 3 red and 2 blue balls. Two balls are drawn without replacement.

1. Compute the probability that the second ball is red. (10 points)
2. Given that the second ball is red, compute the probability that the first one was blue. (10 points)

**Solution.** By total probability, P(R2) = (3/5)(2/4) + (2/5)(3/4) = 6/20 + 6/20 = 3/5. By Bayes'
rule, P(B1 | R2) = P(R2 | B1) P(B1) / P(R2) = (3/4)(2/5) / (3/5) = 1/2.

## Exercise 3 (20 points)

Let X ~ Geometric(p) on {1, 2, ...}.

1. Show that P(X > k) = (1 − p)^k. (8 points)
2. Deduce E[X] with the tail formula. (6 points)
3. Show that P(X > m + n | X > m) = P(X > n) (memorylessness). (6 points)

**Solution.** X > k means the first k trials fail, probability (1 − p)^k. Then
E[X] = Σ_{k ≥ 0} P(X > k) = Σ (1 − p)^k = 1/p. Finally
P(X > m + n | X > m) = (1 − p)^(m + n) / (1 − p)^m = (1 − p)^n = P(X > n).

## Exercise 4 (20 points)

n people each pick a seat at random among n seats, all permutations being equally likely. Let F be the
number of people sitting in their own seat.

1. Write F as a sum of indicators and compute E[F]. (10 points)
2. Compute Var(F). (10 points)

**Solution.** F = Σ 1_{Ai} where Ai = {person i sits in seat i}, P(Ai) = 1/n, so E[F] = 1. For i ≠ j,
P(Ai ∩ Aj) = 1/(n(n − 1)), hence E[F^2] = E[F] + n(n − 1) · 1/(n(n − 1)) = 2 and Var(F) = 2 − 1 = 1
(for n ≥ 2).

## Exercise 5 (20 points)

Let N ~ Poisson(λ) and, given N = n, let X ~ Binomial(n, p).

1. Compute E[X | N] and deduce E[X]. (8 points)
2. Compute Var(X) with the law of total variance. (6 points)
3. Show that X ~ Poisson(λp). (6 points)

**Solution.** E[X | N] = Np, so E[X] = λp. Var(X | N) = Np(1 − p), so
Var(X) = E[Np(1 − p)] + Var(Np) = λp(1 − p) + λp^2 = λp. For the distribution,
P(X = k) = Σ_{n ≥ k} e^(−λ) λ^n / n! · C(n, k) p^k (1 − p)^(n − k) = e^(−λp) (λp)^k / k!.
