function institutionalScore(flow) {

  let score = 0;

  const premium = Number(flow.premium || 0);

  if (premium >= 1000000) score += 5;
  else if (premium >= 500000) score += 4;
  else if (premium >= 250000) score += 3;
  else if (premium >= 150000) score += 2;

  if (flow.is_sweep) score += 2;

  if (
    String(flow.execution_type || '')
      .includes('Ask')
  ) {
    score += 2;
  }

  return score;

}

function institutionalText(score) {

  if (score >= 8)
    return '🏦 مؤسسي قوي جدًا';

  if (score >= 6)
    return '🏦 مؤسسي';

  if (score >= 4)
    return '🟡 شبه مؤسسي';

  return '👤 ريتيل';

}

module.exports = {
  institutionalScore,
  institutionalText
};
