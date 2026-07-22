# Contrato de jobs (reservado — F2)

O subset `src/jobs/` fica ISOLADO por decisão D4r: o contrato
lock/complete/fail com lease (`lock_token`, D12) nasce aqui na F2 e é o único
caminho de execução de trabalho. O isolamento existe para a promoção futura a
`@buildtovalue/worker-sdk` público (F5) ser um recorte limpo, sem refatoração.

Nada é exportado daqui até a F2.
