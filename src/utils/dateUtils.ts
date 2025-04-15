/**
 * Utility functions for handling dates and timezones
 */

/**
 * Sets a date to midnight Eastern Time
 * This accounts for daylight savings time automatically
 */
export function setEasternTimeMidnight(date: Date): Date {
  // Create a new date object to avoid modifying the input
  const newDate = new Date(date);
  
  // Convert to Eastern Time string
  const etString = newDate.toLocaleString('en-US', { timeZone: 'America/New_York' });
  const etDate = new Date(etString);
  
  // Set to midnight
  etDate.setHours(0, 0, 0, 0);
  
  // Convert back to UTC
  return new Date(etDate.getTime() + etDate.getTimezoneOffset() * 60000);
}

/**
 * Converts a UTC date to Eastern Time
 */
export function convertToET(date: Date): Date {
  return new Date(date.toLocaleString('en-US', { timeZone: 'America/New_York' }));
}

/**
 * Formats a date as YYYY-MM-DD
 */
export function formatDateYMD(date: Date): string {
  return date.toISOString().split('T')[0];
} 