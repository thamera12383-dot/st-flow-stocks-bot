const trackedContracts = new Map();

function trackContract(flow) {

  const contract =
    String(flow.contract || flow.sym || '');

  if (!contract) return null;

  const now = Date.now();

  if (!trackedContracts.has(contract)) {

    trackedContracts.set(contract, {
      contract,
      firstSeen: now,
      lastSeen: now,
      totalPremium: 0,
      totalSize: 0,
      sweeps: 0,
      hits: 0,
      askHits: 0,
      bidHits: 0
    });

  }

  const item =
    trackedContracts.get(contract);

  item.lastSeen = now;

  item.totalPremium +=
    Number(flow.premium || 0);

  item.totalSize +=
    Number(flow.size || 0);

  item.hits += 1;

  if (flow.is_sweep)
    item.sweeps += 1;

  const exec =
    String(flow.execution_type || '');

  if (exec.includes('Ask'))
    item.askHits += 1;

  if (exec.includes('Bid'))
    item.bidHits += 1;

  return item;

}

function contractStrength(contract) {

  let score = 0;

  if (contract.totalPremium >= 1000000)
    score += 5;

  else if (contract.totalPremium >= 500000)
    score += 4;

  else if (contract.totalPremium >= 250000)
    score += 3;

  if (contract.hits >= 3)
    score += 2;

  if (contract.sweeps >= 2)
    score += 2;

  if (contract.askHits >= 2)
    score += 2;

  return score;

}

function contractClassification(score) {

  if (score >= 8)
    return '🔥 بناء مركز مؤسسي قوي';

  if (score >= 6)
    return '🏦 نشاط مؤسسي';

  if (score >= 4)
    return '🟡 نشاط متكرر';

  return '👤 تدفق عادي';

}

module.exports = {
  trackContract,
  contractStrength,
  contractClassification
};
