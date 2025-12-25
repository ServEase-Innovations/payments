// services/serviceDays.service.js

function getDateRange(startDate, endDate) {
  const dates = [];
  let current = new Date(startDate + "T00:00:00");
  const end = new Date(endDate + "T00:00:00");

  while (current <= end) {
    dates.push(new Date(current));
    current.setDate(current.getDate() + 1);
  }
  return dates;
}

export async function createServiceDays(client, engagementId, startDate, endDate) {
  const dates = getDateRange(startDate, endDate);

  const query = `
    INSERT INTO service_days (engagement_id, service_date, status)
    VALUES ($1, $2::date, 'SCHEDULED')
    ON CONFLICT DO NOTHING
  `;

  for (const date of dates) {
    const serviceDate = date.toISOString().slice(0, 10);
    await client.query(query, [engagementId, serviceDate]);
  }
}
