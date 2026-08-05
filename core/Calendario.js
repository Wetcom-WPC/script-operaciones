function esFeriadoHoy() {
  const calendarId = PropertiesService.getScriptProperties().getProperty("HOLIDAYS_CALENDAR_ID"); 
  try {
    const calendario = CalendarApp.getCalendarById(calendarId);
    if (!calendario) return false;
    return calendario.getEventsForDay(new Date()).length > 0;
  } catch (error) { return false; }
}
