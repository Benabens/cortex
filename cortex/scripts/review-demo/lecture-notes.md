# DEMO-101 Probability: lecture notes

*Demo material written for the Cortex reviewer account. It is not taken from any real course.*

## 1. Discrete random variables

A **discrete random variable** X takes values in a finite or countable set {x1, x2, ...}. Its
**probability mass function** (pmf) is p(x) = P(X = x), with p(x) ≥ 0 and the sum of p(x) over all
values equal to 1. The **cumulative distribution function** is F(x) = P(X ≤ x); it is non-decreasing,
right-continuous, and goes from 0 to 1.

Standard examples:

- **Bernoulli(p)**: X ∈ {0, 1}, P(X = 1) = p.
- **Binomial(n, p)**: number of successes in n independent Bernoulli(p) trials,
  P(X = k) = C(n, k) p^k (1 − p)^(n − k) for k = 0, ..., n.
- **Geometric(p)**: number of trials until the first success, P(X = k) = (1 − p)^(k − 1) p for k ≥ 1.
- **Poisson(λ)**: P(X = k) = e^(−λ) λ^k / k! for k ≥ 0; the limit of Binomial(n, λ/n) as n → ∞.

## 2. Expectation

The **expectation** of X is E[X] = Σ x p(x), defined when the sum converges absolutely. For a function
g, E[g(X)] = Σ g(x) p(x) (law of the unconscious statistician).

Properties:

- **Linearity**: E[aX + bY] = a E[X] + b E[Y], with no independence assumption.
- **Indicators**: for an event A, E[1_A] = P(A). Writing a count as a sum of indicators is often the
  fastest way to compute its expectation.
- **Tail formula**: for X with values in {0, 1, 2, ...}, E[X] = Σ_{k ≥ 1} P(X ≥ k).

Values: E[Bernoulli(p)] = p, E[Binomial(n, p)] = np, E[Geometric(p)] = 1/p, E[Poisson(λ)] = λ.

## 3. Variance

Var(X) = E[(X − E[X])^2] = E[X^2] − E[X]^2. Var(aX + b) = a^2 Var(X). If X and Y are independent,
Var(X + Y) = Var(X) + Var(Y); in general Var(X + Y) = Var(X) + Var(Y) + 2 Cov(X, Y), where
Cov(X, Y) = E[XY] − E[X] E[Y].

Values: Var(Binomial(n, p)) = np(1 − p), Var(Geometric(p)) = (1 − p)/p^2, Var(Poisson(λ)) = λ.

**Markov's inequality**: for X ≥ 0 and a > 0, P(X ≥ a) ≤ E[X]/a.
**Chebyshev's inequality**: P(|X − E[X]| ≥ a) ≤ Var(X)/a^2.

## 4. Conditional probability and independence

P(A | B) = P(A ∩ B) / P(B) when P(B) > 0. **Law of total probability**: if B1, ..., Bn partition the
sample space, P(A) = Σ P(A | Bi) P(Bi). **Bayes' rule**: P(Bi | A) = P(A | Bi) P(Bi) / P(A).
A and B are **independent** when P(A ∩ B) = P(A) P(B).

## 5. Conditional expectation

For discrete X and Y, the **conditional expectation** of X given Y = y is
E[X | Y = y] = Σ x P(X = x | Y = y). The random variable E[X | Y] takes the value E[X | Y = y] when
Y = y.

- **Tower property (law of total expectation)**: E[E[X | Y]] = E[X].
- If X and Y are independent, E[X | Y] = E[X].
- **Taking out what is known**: E[g(Y) X | Y] = g(Y) E[X | Y].
- **Law of total variance**: Var(X) = E[Var(X | Y)] + Var(E[X | Y]).

Example: a die is rolled, then a fair coin is tossed as many times as the number shown; let H be the
number of heads and D the die. E[H | D] = D/2, so E[H] = E[D]/2 = 3.5/2 = 1.75.
