// Fill the about:blank frame, and load the cross-origin frame from the other
// host name (localhost <-> 127.0.0.1).
const blank = document.getElementById('blank').contentDocument;
blank.documentElement.lang = 'en';
blank.title = 'Blank';
blank.body.innerHTML = '<button type="button"></button>';
const other = location.hostname === 'localhost' ? '127.0.0.1' : 'localhost';
document.getElementById('cross').src = `${location.protocol}//${other}:${location.port}/frame-other.html`;
document.getElementById('port').src = `${location.protocol}//${location.hostname}:${Number(location.port) + 1}/frame-other.html`;
