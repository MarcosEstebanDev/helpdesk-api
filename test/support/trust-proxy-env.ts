/**
 * Fija `TRUST_PROXY_HOPS` ANTES de que se cargue `AppModule`.
 *
 * `ConfigModule.forRoot` valida el entorno al evaluarse el decorador, o sea al
 * importarse el módulo, no al compilar la app del test. Una asignación a
 * `process.env` en el cuerpo de la suite llegaría tarde. Este archivo se importa
 * primero y los `require` de CommonJS corren en orden.
 */
process.env.TRUST_PROXY_HOPS = '1';
