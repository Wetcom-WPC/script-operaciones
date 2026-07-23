const searchStr = 'subject:"Alertas de vSphere" has:attachment is:unread';
const threads = GmailApp.search(searchStr);
let logData = "";
threads.forEach((t, i) => {
  const msgs = t.getMessages();
  const m = msgs[msgs.length - 1];
  logData += `Thread ${i}:\n`;
  logData += `  Subject: ${m.getSubject()}\n`;
  const atts = m.getAttachments();
  atts.forEach((a, j) => {
    logData += `  Att ${j}: ${a.getName()}\n`;
  });
});
console.log(logData);
