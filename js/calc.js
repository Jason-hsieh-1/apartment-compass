/* Pure calculation functions. No DOM access, so they can be tested in Node. */
(function (root) {
  // Grunderwerbsteuer (property transfer tax) by federal state, % of purchase price.
  const STATES = {
    BW: { name: 'Baden-Württemberg', tax: 5.0, slug: 'baden-wuerttemberg' },
    BY: { name: 'Bavaria (Bayern)', tax: 3.5, slug: 'bayern' },
    BE: { name: 'Berlin', tax: 6.0, slug: 'berlin' },
    BB: { name: 'Brandenburg', tax: 6.5, slug: 'brandenburg' },
    HB: { name: 'Bremen', tax: 5.5, slug: 'bremen' },
    HH: { name: 'Hamburg', tax: 5.5, slug: 'hamburg' },
    HE: { name: 'Hesse (Hessen)', tax: 6.0, slug: 'hessen' },
    MV: { name: 'Mecklenburg-Vorpommern', tax: 6.0, slug: 'mecklenburg-vorpommern' },
    NI: { name: 'Lower Saxony (Niedersachsen)', tax: 5.0, slug: 'niedersachsen' },
    NW: { name: 'North Rhine-Westphalia (NRW)', tax: 6.5, slug: 'nordrhein-westfalen' },
    RP: { name: 'Rhineland-Palatinate', tax: 5.0, slug: 'rheinland-pfalz' },
    SL: { name: 'Saarland', tax: 6.5, slug: 'saarland' },
    SN: { name: 'Saxony (Sachsen)', tax: 5.5, slug: 'sachsen' },
    ST: { name: 'Saxony-Anhalt', tax: 5.0, slug: 'sachsen-anhalt' },
    SH: { name: 'Schleswig-Holstein', tax: 6.5, slug: 'schleswig-holstein' },
    TH: { name: 'Thuringia (Thüringen)', tax: 5.0, slug: 'thueringen' },
  };

  const num = (v) => (Number.isFinite(+v) ? +v : 0);

  function purchaseCosts({ price, state, notaryPct, brokerPct }) {
    price = num(price);
    const taxPct = STATES[state] ? STATES[state].tax : 0;
    const transferTax = (price * taxPct) / 100;
    const notary = (price * num(notaryPct)) / 100;
    const broker = (price * num(brokerPct)) / 100;
    return { taxPct, brokerPct: num(brokerPct), transferTax, notary, broker, total: transferTax + notary + broker };
  }

  /**
   * Annuity loan with fixed monthly payment = principal * (interest + initial repayment) / 12.
   * Returns yearly rows and key figures. Interest is compounded monthly on the balance.
   */
  function loanSchedule({ principal, ratePct, repayPct, fixYears }) {
    principal = Math.max(0, num(principal));
    const r = num(ratePct) / 100 / 12;
    const payment = (principal * (num(ratePct) + num(repayPct))) / 100 / 12;
    const rows = [];
    let balance = principal;
    let totalInterest = 0;
    let interestFix = 0;
    let balanceAtFix = principal;
    let months = 0;
    const maxMonths = 100 * 12;
    let yInterest = 0, yPrincipal = 0;
    while (balance > 0.005 && months < maxMonths) {
      const interest = balance * r;
      const pay = Math.min(payment, balance + interest);
      const princ = pay - interest;
      if (princ <= 0 && months > 0 && payment <= interest) break; // never amortises
      balance -= princ;
      totalInterest += interest;
      yInterest += interest;
      yPrincipal += princ;
      months++;
      if (months % 12 === 0 || balance <= 0.005) {
        rows.push({ year: Math.ceil(months / 12), interest: yInterest, principal: yPrincipal, balance: Math.max(0, balance) });
        yInterest = 0; yPrincipal = 0;
      }
      if (months === Math.round(num(fixYears) * 12)) {
        balanceAtFix = Math.max(0, balance);
        interestFix = totalInterest;
      }
    }
    const amortises = balance <= 0.005;
    if (months < Math.round(num(fixYears) * 12)) { balanceAtFix = Math.max(0, balance); interestFix = totalInterest; }
    return {
      payment, rows, balanceAtFix, interestFix, totalInterest,
      yearsToPayoff: amortises ? months / 12 : Infinity,
      year1Principal: rows[0] ? rows[0].principal : 0,
      year1Interest: rows[0] ? rows[0].interest : 0,
    };
  }

  /** Full analysis of one apartment under the shared assumptions `a`. */
  function analyze(l, a) {
    const price = num(l.price), size = num(l.size);
    // An apartment's own commission (from its exposé) overrides the default assumption.
    const brokerPct = l.commissionPct != null && l.commissionPct !== '' ? num(l.commissionPct) : a.brokerPct;
    const costs = purchaseCosts({ price, state: l.state, notaryPct: a.notaryPct, brokerPct });
    const totalCost = price + costs.total;
    const equity = a.equityMode === 'euro'
      ? Math.min(num(a.equityValue), totalCost)
      : (price * num(a.equityValue)) / 100;
    const principal = Math.max(0, totalCost - equity);
    const loan = loanSchedule({ principal, ratePct: a.ratePct, repayPct: a.repayPct, fixYears: a.fixYears });
    const annualDebt = loan.payment * 12;

    const annualRent = num(l.rent) * 12;
    const effectiveRent = annualRent * (1 - num(a.vacancyPct) / 100);
    const nonRecoverable = Math.max(0, num(l.hausgeld) - num(l.umlagefaehig)) * 12;
    const maintenance = num(a.maintPerSqm) * size;
    const mgmt = num(a.mgmtPerMonth) * 12;
    const noi = effectiveRent - nonRecoverable - maintenance - mgmt;
    const cashflow = noi - annualDebt;

    return {
      price, size, costs, totalCost, equity, principal, loan, annualDebt,
      pricePerSqm: size > 0 ? price / size : null,
      annualRent, effectiveRent, nonRecoverable, maintenance, mgmt, noi, cashflow,
      grossYield: price > 0 && annualRent > 0 ? annualRent / price : null,
      netYield: totalCost > 0 && annualRent > 0 ? noi / totalCost : null,
      priceToRent: annualRent > 0 ? price / annualRent : null,
      cashOnCash: equity > 0 && annualRent > 0 ? cashflow / equity : null,
      cashOnCashWithRepay: equity > 0 && annualRent > 0 ? (cashflow + loan.year1Principal) / equity : null,
      breakEvenRent: (nonRecoverable + maintenance + mgmt + annualDebt) / 12 / (1 - num(a.vacancyPct) / 100),
      // Owner-occupier view (living in it yourself)
      ownerMonthly: loan.payment + num(l.hausgeld) + maintenance / 12,
    };
  }

  const api = { STATES, purchaseCosts, loanSchedule, analyze };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Calc = api;
})(typeof window !== 'undefined' ? window : globalThis);
