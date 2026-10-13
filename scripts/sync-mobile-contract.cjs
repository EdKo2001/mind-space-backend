const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const ts = require('typescript');
const project = path.resolve(__dirname, '..');
const sourceRoot = path.resolve(process.argv.find(arg => !arg.startsWith('--') && arg !== process.argv[0] && arg !== process.argv[1]) || path.join(project, '../MindSpace'));
const sourcePath = path.join(sourceRoot, 'src/features/session/mock-therapist/contract.ts');
const presetsPath = path.join(sourceRoot, 'src/features/session/avatar-animation/generated.ts');
const source = fs.readFileSync(sourcePath, 'utf8');
const presets = fs.readFileSync(presetsPath, 'utf8');
const ast = ts.createSourceFile('generated.ts', presets, ts.ScriptTarget.Latest, true);
const statement = ast.statements.find(node => ts.isVariableStatement(node) && node.declarationList.declarations.some(d => d.name.getText(ast) === 'animationData'));
let expression = statement?.declarationList.declarations[0].initializer;
if (expression && ts.isAsExpression(expression)) expression = expression.expression;
if (!expression || !ts.isObjectLiteralExpression(expression)) throw new Error('Unsupported animation data source');
const weights = expression.properties.find(node => ts.isPropertyAssignment(node) && node.name.getText(ast).replaceAll('"', '') === 'presetWeights');
if (!weights || !ts.isObjectLiteralExpression(weights.initializer)) throw new Error('Missing actual preset IDs');
const emotionIds = weights.initializer.properties.map(node => node.name.text);
if (!emotionIds.includes('neutral')) throw new Error('Neutral preset required');
let generated = source.replace("import { animationData } from '../avatar-animation/generated';\nimport type { ExpressionId } from '../avatar-animation';\n", '');
generated = generated.replace('export type Emotion = ExpressionId;', `export const emotionIds = ${JSON.stringify(emotionIds)} as const;\nexport type Emotion = typeof emotionIds[number];`);
generated = generated.replace('Object.prototype.hasOwnProperty.call(animationData.presetWeights, id)', 'emotionIds.includes(id as Emotion)');
if (generated === source || generated.includes('animationData.') || generated.includes('ExpressionId')) throw new Error('Upstream contract changed; inspect generator');
generated = '// Generated from the MindSpace mobile contract. Run npm run sync:contract; do not edit.\n'+generated;
const manifest = JSON.stringify({ protocolVersion: 1, source: 'MindSpace/src/features/session/mock-therapist/contract.ts',
  contractSha256: createHash('sha256').update(source).digest('hex'), presetSourceSha256: createHash('sha256').update(presets).digest('hex'),
  emotionIds, note: 'Types and validators preserved; renderer imports replaced with actual preset IDs.' }, null, 2)+'\n';
const files = [['src/protocol/therapist.ts', generated], ['references/mobile-contract.json', manifest]];
for (const [relative, content] of files) {
  const output = path.join(project, relative);
  if (process.argv.includes('--check')) {
    if (fs.readFileSync(output, 'utf8') !== content) throw new Error(`Contract drift: ${relative}`);
  } else { fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, content); }
}
console.log(process.argv.includes('--check') ? 'Mobile contract parity PASS' : 'Mobile contract generated with provenance');
