const fs = require('fs');
const path = require('path');

function walk(dir) {
  let results = [];
  const list = fs.readdirSync(dir);
  list.forEach(file => {
    file = path.join(dir, file);
    const stat = fs.statSync(file);
    if (stat && stat.isDirectory()) {
      results = results.concat(walk(file));
    } else {
      if (file.endsWith('.js') || file.endsWith('.gs')) {
        results.push(file);
      }
    }
  });
  return results;
}

const files = walk('C:/Users/WETCOM/Desktop/Script Operaciones/Ops Operativo');

const slackRegex = /https:\/\/hooks\.slack\.com\/services\/[A-Z0-9]+\/[A-Z0-9]+\/[A-Za-z0-9]+/g;
const jiraRegex = /Basic [A-Za-z0-9+/=]+/g;
// Custom basic tokens in other formats if any
const atlassianRegex = /ATATT3xFfGF[a-zA-Z0-9-_]+/g; 

let redactedCount = 0;

files.forEach(file => {
  let content = fs.readFileSync(file, 'utf8');
  let changed = false;
  
  if (slackRegex.test(content)) {
    content = content.replace(slackRegex, 'REDACTED_SLACK_WEBHOOK');
    changed = true;
  }
  if (jiraRegex.test(content)) {
    content = content.replace(jiraRegex, 'Basic REDACTED_JIRA_TOKEN_JIRA_TOKEN');
    changed = true;
  }
  // Remove raw API tokens that might have been detected
  if (content.match(atlassianRegex)) {
    content = content.replace(atlassianRegex, 'REDACTED_ATLASSIAN_TOKEN');
    changed = true;
  }
  // Replace direct tokens if any
  const tokenRegex = /(["'`])([a-zA-Z0-9-_]{40,})(["'`])/g;
  content = content.replace(tokenRegex, (match, p1, p2, p3) => {
      // Very naive heuristic for long random strings which might be tokens
      if (p2.includes('ATATT') || p2.length > 50) {
          changed = true;
          return p1 + "REDACTED_LONG_STRING" + p3;
      }
      return match;
  });

  if (changed) {
    fs.writeFileSync(file, content, 'utf8');
    redactedCount++;
    console.log('Redacted secrets in ' + file);
  }
});

console.log(`Finished redacting in ${redactedCount} files.`);
