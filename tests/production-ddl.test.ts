import {describe,it,expect} from 'vitest';
import {buildAllDdl,buildAlterScript,buildReconciliation,columnTypesCompatible,type ModelEntity} from '../src';
const table=(id:string,ref?:string):ModelEntity=>({id,name:id,tableName:id,source:'schema',columns:[{name:'id',columnName:'id',jsonType:'integer',format:'int64',primaryKey:true,nullable:false,unique:false},...(ref?[{name:'parent_id',columnName:'parent_id',jsonType:'integer' as const,format:'int64',primaryKey:false,nullable:true,unique:false,refEntityId:ref}]:[])]});
describe('production SQL boundaries',()=>{
 it('creates cyclic tables first and adds the deferred foreign key afterwards',()=>{
  const result=buildAllDdl('mysql',[table('a','b'),table('b','a')]);
  expect(result.skippedForeignKeys).toEqual([]);expect(result.statements).toHaveLength(3);expect(result.statements[2]).toMatch(/^ALTER TABLE/);
 });
 it.each(['oracle','sqlserver'] as const)('never emits unsupported IF NOT EXISTS syntax for %s',dialect=>{
  expect(buildAllDdl(dialect,[table('a')]).sql).not.toContain('IF NOT EXISTS');
 });
 it('uses the actual catalog schema and leaves unsafe required additions for review',()=>{
  const statements=buildAlterScript('sqlserver',table('users'),{schema:'tenant',name:'users',columns:[{name:'name',dataType:'NVARCHAR(20)'}]},[table('users')]);
  expect(statements[0]).toContain('-- ALTER TABLE [tenant].[users] ADD [id]');expect(statements[0]).toMatch(/^-- REVIEW ONLY/);
 });
 it('offers missing foreign keys as review-only ALTER proposals',()=>{
  const entities=[table('users'),table('orders','users')];
  const report=buildReconciliation({doc:{},entities,liveTables:entities.map(t=>({name:t.tableName,columns:t.columns.map(c=>({name:c.columnName,dataType:'BIGINT'}))})),liveForeignKeys:[]});
  const step=report.migrationPlan.find(s=>s.sql.some(sql=>sql.includes('ADD FOREIGN KEY')));
  expect(step?.requiresReview).toBe(true);expect(step?.sql[0]).toMatch(/^-- REVIEW ONLY/);
 });
 it('does not consider unrelated unknown SQL types compatible by their first letter',()=>{
  expect(columnTypesCompatible('mysql',{...table('a').columns[0],jsonType:'boolean'},'TEXT')).toBe(false);
 });
});
