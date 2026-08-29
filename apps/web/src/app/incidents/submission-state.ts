const SUBMISSION_STORAGE_PREFIX = 'careos:incident-submission:';

export function markIncidentSubmissionPending(incidentId: string): void {
  try {
    window.sessionStorage.setItem(storageKey(incidentId), 'pending');
  } catch {
    // Storage can be unavailable in hardened browser contexts; submission still proceeds.
  }
}

export function clearIncidentSubmissionPending(incidentId: string): void {
  try {
    window.sessionStorage.removeItem(storageKey(incidentId));
  } catch {
    // Treat unavailable storage as an absent marker.
  }
}

export function isIncidentSubmissionPending(incidentId: string): boolean {
  try {
    return window.sessionStorage.getItem(storageKey(incidentId)) === 'pending';
  } catch {
    return false;
  }
}

function storageKey(incidentId: string): string {
  return `${SUBMISSION_STORAGE_PREFIX}${incidentId}`;
}
